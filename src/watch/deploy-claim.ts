/**
 * Soft, eventually-consistent deploy claim for shared S3 marker buckets.
 *
 * Two (or more) `chong watch` processes can decide to deploy the same tip. There is no
 * distributed lock service — instead each writer:
 *   1. puts `deploy-claim.json` with this watch's process UUID + username (+ sha, host, time)
 *   2. waits briefly so overlapping writers can overwrite each other
 *   3. reads the claim back; only the surviving UUID proceeds
 *
 * The process UUID is minted once per `chong watch` start — two watches on the same
 * machine/user never share an id, so they cannot accidentally treat each other as "self".
 *
 * Mid-upload, the holder heartbeats the claim; if another writer steals it, the upload
 * is aborted. Losers surface "deploying by <user>" in the TUI and defer. Prod can `force`
 * past a foreign claim. Stale claims expire after {@link CLAIM_STALE_MS} (~20m — longer
 * than any expected deploy, short enough that a dead process does not wedge the bucket).
 */
import { hostname } from "node:os";
import { userInfo } from "node:os";
import { sanitizeClaimField } from "./claim-sanitize";

export const DEPLOY_CLAIM_KEY = "deploy-claim.json";

/** Wait after writing a claim so concurrent writers can race and settle. */
export const CLAIM_PROPAGATION_MS = 3_000;

/** Claims older than this are treated as abandoned (process died mid-deploy). */
export const CLAIM_STALE_MS = 20 * 60 * 1_000;

/** How often the holder rewrites the claim while an upload is in flight. */
export const CLAIM_HEARTBEAT_MS = 15_000;

export type DeployClaim = {
  v: 1;
  id: string;
  user: string;
  sha: string;
  at: string;
  host?: string;
};

export type ClaimAcquireResult =
  | { ok: true; claim: DeployClaim; forced?: boolean }
  | { ok: false; reason: "held"; claim: DeployClaim }
  | {
      ok: false;
      reason: "verify";
      expected: DeployClaim;
      got: DeployClaim | null;
      error?: string;
    }
  | { ok: false; reason: "write"; error: string }
  | { ok: false; reason: "no-bucket" };

export function claimIdentity(): { user: string; host: string } {
  let user = process.env.USER || process.env.LOGNAME || "";
  try {
    if (!user) user = userInfo().username;
  } catch {
    /* ignore */
  }
  if (!user) user = "unknown";
  let host = "";
  try {
    host = hostname();
  } catch {
    host = "";
  }
  return { user, host };
}

/** Build a claim for `sha` owned by this watch process (`processId`). */
export function makeDeployClaim(sha: string, processId: string, now = new Date()): DeployClaim {
  const { user, host } = claimIdentity();
  return {
    v: 1,
    id: processId,
    user,
    sha: sha.toLowerCase(),
    at: now.toISOString(),
    ...(host ? { host } : {}),
  };
}

export function formatDeployClaim(claim: DeployClaim): string {
  return `${JSON.stringify(claim)}\n`;
}

/** Max length kept for a display field after sanitizing (longer input is truncated). */
const CLAIM_FIELD_MAX_LEN = 64;

export function parseDeployClaim(raw: string): DeployClaim | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<DeployClaim>;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.user !== "string" || !parsed.user) return null;
    if (typeof parsed.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(parsed.sha)) return null;
    if (typeof parsed.at !== "string" || !parsed.at) return null;
    const user = sanitizeClaimField(parsed.user, CLAIM_FIELD_MAX_LEN) || "unknown";
    const hostRaw =
      typeof parsed.host === "string" ? sanitizeClaimField(parsed.host, CLAIM_FIELD_MAX_LEN) : "";
    const host = hostRaw || undefined;
    return {
      v: 1,
      id: parsed.id,
      user,
      sha: parsed.sha.toLowerCase(),
      at: parsed.at,
      ...(host ? { host } : {}),
    };
  } catch {
    return null;
  }
}

export function isClaimStale(claim: DeployClaim, nowMs = Date.now()): boolean {
  const t = Date.parse(claim.at);
  if (Number.isNaN(t)) return true;
  return nowMs - t > CLAIM_STALE_MS;
}

export function formatClaimHolder(claim: DeployClaim): string {
  const short = claim.sha.slice(0, 7);
  const where = claim.host ? `@${claim.host}` : "";
  return `${claim.user}${where} (${short})`;
}

export async function readDeployClaim(bucket: string): Promise<DeployClaim | null> {
  const raw = await readS3Text(bucket, DEPLOY_CLAIM_KEY);
  if (raw === null) return null;
  return parseDeployClaim(raw);
}

export async function writeDeployClaim(bucket: string, claim: DeployClaim): Promise<string | null> {
  return writeS3Text(bucket, DEPLOY_CLAIM_KEY, formatDeployClaim(claim));
}

/**
 * Clear the claim only if we still own it (or it is already gone / stale garbage).
 * Avoids wiping a newer claim another process just took. Runs on shutdown paths, so a
 * delete that fails (or a key that is already gone) is swallowed rather than thrown —
 * same tolerance the previous empty-write had.
 */
export async function releaseDeployClaim(
  bucket: string,
  ours: DeployClaim,
): Promise<string | null> {
  const current = await readDeployClaim(bucket);
  if (!current || current.id !== ours.id) return null;
  return deleteS3Object(bucket, DEPLOY_CLAIM_KEY);
}

/**
 * Bounded retries for the write-then-read-back verification in {@link acquireDeployClaim}.
 * A transient GET blip immediately after our own successful PUT must not be mistaken for
 * "another writer's claim won" (there is nothing to fall back to — the bucket really does
 * hold our claim) nor left unresolved: an acquire that gives up on a single failed read
 * abandons a live claim in the bucket with nobody left to release it, so the next watch
 * to read it reports a foreign "deploying by <user>" for up to the full stale window.
 * Retrying rides out the blip; only once it stays unreadable do we treat it as a real
 * failure (see the `got === null` handling at each call site, which releases our own
 * write before returning).
 */
const VERIFY_READBACK_RETRIES = 2;
const VERIFY_READBACK_RETRY_DELAY_MS = 200;

async function readDeployClaimRetrying(
  bucket: string,
  retries: number,
  delayMs: number,
): Promise<DeployClaim | null> {
  let got = await readDeployClaim(bucket);
  for (let attempt = 0; got === null && attempt < retries; attempt++) {
    await sleep(delayMs);
    got = await readDeployClaim(bucket);
  }
  return got;
}

/**
 * Rewrite `at` for a claim we still own. Returns false if someone else took it.
 */
export async function heartbeatDeployClaim(bucket: string, ours: DeployClaim): Promise<boolean> {
  const current = await readDeployClaim(bucket);
  if (!current || current.id !== ours.id) return false;
  const next: DeployClaim = { ...ours, at: new Date().toISOString() };
  const err = await writeDeployClaim(bucket, next);
  if (err) return false;
  ours.at = next.at;
  return true;
}

/**
 * Soft-acquire the right to deploy `sha` into `bucket`.
 *
 * @param processId stable UUID for this `chong watch` process
 * @param force when true (prod only), overwrite and proceed even if another claim wins
 */
export async function acquireDeployClaim(
  bucket: string,
  sha: string,
  processId: string,
  opts: {
    force?: boolean;
    waitMs?: number;
    onProgress?: (msg: string) => void;
    /** Test hook: override the read-back retry count (default {@link VERIFY_READBACK_RETRIES}). */
    verifyRetries?: number;
    /** Test hook: override the read-back retry delay (default {@link VERIFY_READBACK_RETRY_DELAY_MS}). */
    verifyRetryDelayMs?: number;
  } = {},
): Promise<ClaimAcquireResult> {
  const note = opts.onProgress ?? (() => {});
  const waitMs = opts.waitMs ?? CLAIM_PROPAGATION_MS;
  const force = opts.force === true;
  const verifyRetries = opts.verifyRetries ?? VERIFY_READBACK_RETRIES;
  const verifyRetryDelayMs = opts.verifyRetryDelayMs ?? VERIFY_READBACK_RETRY_DELAY_MS;

  const existing = await readDeployClaim(bucket);
  if (existing && !isClaimStale(existing) && existing.id !== processId && !force) {
    return { ok: false, reason: "held", claim: existing };
  }

  const claim = makeDeployClaim(sha, processId);
  note(`deploy claim: writing as ${formatClaimHolder(claim)}…`);
  const writeErr = await writeDeployClaim(bucket, claim);
  if (writeErr) return { ok: false, reason: "write", error: writeErr };

  if (waitMs > 0) {
    note(`deploy claim: waiting ${Math.round(waitMs / 1000)}s for competing writers…`);
    await sleep(waitMs);
  }

  const got = await readDeployClaimRetrying(bucket, verifyRetries, verifyRetryDelayMs);
  if (got && got.id === claim.id) {
    return { ok: true, claim };
  }

  if (force) {
    note(`deploy claim: FORCE — overwriting ${got ? formatClaimHolder(got) : "(empty)"}`);
    const forced = makeDeployClaim(sha, processId);
    const forceErr = await writeDeployClaim(bucket, forced);
    if (forceErr) return { ok: false, reason: "write", error: forceErr };

    if (waitMs > 0) {
      note(`deploy claim: waiting ${Math.round(waitMs / 1000)}s for competing writers…`);
      await sleep(waitMs);
    }

    const gotAfterForce = await readDeployClaimRetrying(bucket, verifyRetries, verifyRetryDelayMs);
    if (gotAfterForce && gotAfterForce.id === forced.id) {
      return { ok: true, claim: forced, forced: true };
    }

    if (gotAfterForce === null) {
      // We know the PUT above succeeded; the verifying read still can't see it even
      // after retrying. Don't abandon a live claim in the bucket — release the one we
      // just wrote so the next watch to look doesn't see a foreign claim with nobody
      // around to clear it.
      await releaseDeployClaim(bucket, forced);
    }

    return {
      ok: false,
      reason: "verify",
      expected: forced,
      got: gotAfterForce,
      error: gotAfterForce
        ? `claim read-back mismatch (got ${formatClaimHolder(gotAfterForce)})`
        : "claim read-back empty after write, even after retrying — wrote claim released",
    };
  }

  if (got && !isClaimStale(got)) {
    return { ok: false, reason: "held", claim: got };
  }

  if (got === null) {
    // Same reasoning as the force branch above: our own write succeeded, the read-back
    // just can't confirm it, so don't leave that claim behind for someone else to trip
    // over as a phantom "held by <us>".
    await releaseDeployClaim(bucket, claim);
  }

  return {
    ok: false,
    reason: "verify",
    expected: claim,
    got,
    error: got
      ? `claim read-back mismatch (got ${formatClaimHolder(got)})`
      : "claim read-back empty after write, even after retrying — wrote claim released",
  };
}

/** Write then read back; returns mismatch details when the store does not echo our value. */
export async function writeS3TextVerified(
  bucket: string,
  key: string,
  value: string,
): Promise<{
  ok: boolean;
  error?: string;
  mismatch?: { expected: string; actual: string | null };
}> {
  const expected = value.endsWith("\n") ? value : `${value}\n`;
  const writeErr = await writeS3Text(bucket, key, expected);
  if (writeErr) return { ok: false, error: writeErr };

  const actual = await readS3Text(bucket, key);
  const norm = (s: string | null) => (s ?? "").replace(/\r\n/g, "\n").trim();
  if (norm(actual) !== norm(expected)) {
    return {
      ok: false,
      mismatch: { expected: norm(expected), actual: actual === null ? null : norm(actual) },
    };
  }
  return { ok: true };
}

export async function writeS3ShaMarkerVerified(
  bucket: string,
  key: string,
  sha: string,
): Promise<{
  ok: boolean;
  error?: string;
  mismatch?: { expected: string; actual: string | null };
}> {
  return writeS3TextVerified(bucket, key, `${sha.toLowerCase()}\n`);
}

async function writeS3Text(bucket: string, key: string, value: string): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  const body = value.endsWith("\n") || value === "" ? value : `${value}\n`;
  const proc = Bun.spawn(
    [
      "aws",
      "s3",
      "cp",
      "-",
      uri,
      "--cache-control",
      "no-store",
      "--content-type",
      key.endsWith(".json") ? "application/json" : "text/plain",
      "--quiet",
    ],
    {
      stdin: new Blob([body]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AWS_PAGER: "" },
    },
  );
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return code === 0 ? null : err.trim() || `aws s3 cp failed (${code})`;
}

async function deleteS3Object(bucket: string, key: string): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  const proc = Bun.spawn(["aws", "s3", "rm", uri, "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AWS_PAGER: "" },
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return code === 0 ? null : err.trim() || `aws s3 rm failed (${code})`;
}

async function readS3Text(bucket: string, key: string): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  const proc = Bun.spawn(["aws", "s3", "cp", uri, "-", "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AWS_PAGER: "" },
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
