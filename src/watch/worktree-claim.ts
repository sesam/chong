/**
 * Soft ownership of a chong shadow worktree (main-shadow or a per-target deploy tree).
 *
 * Multiple `chong watch` processes on one machine share paths under
 * `~/.chong/worktrees/<repo>-*-shadow-*`. Each path has its own owner file *beside*
 * the worktree (not inside it) so `git clean -fd` / hard-reset cannot wipe the claim
 * mid-run. Stage-deploy and prod-deploy trees are claimed only for the duration of a
 * deploy and released afterward; main-shadow is held for the whole watch session.
 *
 * Stale detection uses the file's mtime: the owning process touches it on a fixed timer for
 * as long as it still owns the worktree — liveness does not depend on repo activity, so a
 * quiet `main` or a long-running deploy/maintain pass does not let the claim age out. The
 * touch interval is a fraction of {@link WORKTREE_CLAIM_STALE_MS} so several touches land per
 * stale window, leaving margin for scheduling jitter or a slow tick. After a full stale
 * window with no touch, another watch may take over (or the operator can force-override).
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { sanitizeDisplayText } from "./sanitize-display";

/** Window with no touch after which another watch may take over the claim. */
export const WORKTREE_CLAIM_STALE_MS = 20 * 60 * 1_000;
/**
 * How often the owning process refreshes the claim. A third of the stale window means
 * several touches land per window, so jitter or one slow tick can't make a live owner
 * look abandoned. Derived from the stale window so the two constants can't drift apart.
 */
export const WORKTREE_CLAIM_TOUCH_MS = Math.floor(WORKTREE_CLAIM_STALE_MS / 3);

export type WorktreeClaim = {
  v: 1;
  id: string;
  user: string;
  at: string;
  host?: string;
  pid?: number;
};

export function worktreeOwnerPath(shadowPath: string): string {
  return `${shadowPath}.owner.json`;
}

function identity(): { user: string; host: string } {
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
    /* ignore */
  }
  return { user, host };
}

export function formatWorktreeHolder(claim: WorktreeClaim): string {
  const where = claim.host ? `@${claim.host}` : "";
  const pid = claim.pid != null ? ` pid=${claim.pid}` : "";
  return `${claim.user}${where}${pid}`;
}

/** Cap on `user` / `host` after sanitization — plenty for any real identity string. */
const CLAIM_FIELD_MAX_LEN = 80;

export function parseWorktreeClaim(raw: string): WorktreeClaim | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<WorktreeClaim>;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.user !== "string" || !parsed.user) return null;
    if (typeof parsed.at !== "string" || !parsed.at) return null;
    const user = sanitizeDisplayText(parsed.user, CLAIM_FIELD_MAX_LEN);
    if (!user) return null;
    const host =
      typeof parsed.host === "string" ? sanitizeDisplayText(parsed.host, CLAIM_FIELD_MAX_LEN) : "";
    return {
      v: 1,
      id: parsed.id,
      user,
      at: parsed.at,
      ...(host ? { host } : {}),
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
    };
  } catch {
    return null;
  }
}

export function readWorktreeClaim(shadowPath: string): WorktreeClaim | null {
  const p = worktreeOwnerPath(shadowPath);
  if (!existsSync(p)) return null;
  try {
    return parseWorktreeClaim(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Active when the owner file exists and its mtime is within the stale window. */
export function isWorktreeClaimActive(shadowPath: string, nowMs = Date.now()): boolean {
  const p = worktreeOwnerPath(shadowPath);
  if (!existsSync(p)) return false;
  try {
    const st = statSync(p);
    return nowMs - st.mtimeMs < WORKTREE_CLAIM_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Write the owner file by writing a temp file in the same directory and `renameSync`ing
 * it over the target, rather than `writeFileSync`ing the target path directly.
 *
 * `writeFileSync(p, ...)` opens `p` for writing and, if `p` is a symlink, follows it —
 * so a same-user process that plants a symlink at the owner-file path (pointing at, say,
 * an operator-owned dotfile) could use a legitimate claim write to overwrite that file's
 * contents with claim JSON. `renameSync(tmp, p)` never opens or follows whatever
 * currently sits at `p`: POSIX rename() replaces the directory entry at the destination
 * atomically, symlink or not, the same way `unlink` doesn't follow a symlink target. This
 * keeps the replace atomic (the property the stale-takeover/force/touch paths rely on)
 * without following a planted link. It deliberately does not touch
 * {@link createWorktreeClaimExclusive}'s `wx` create path — that one must fail on an
 * existing path rather than ever replace anything, which `O_EXCL` already guarantees.
 */
export function writeWorktreeClaim(shadowPath: string, claim: WorktreeClaim): void {
  const p = worktreeOwnerPath(shadowPath);
  const dir = path.dirname(p);
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = path.join(dir, `.${path.basename(p)}.tmp-${suffix}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up, or already gone */
    }
    throw err;
  }
}

/**
 * Create the owner file only if it does not already exist (`O_EXCL`), so two processes
 * racing to claim an unowned worktree cannot both believe they won. Returns `false` on
 * `EEXIST` (another process created it first) rather than throwing; other errors propagate.
 * Used only for the no-existing-claim path in {@link acquireWorktreeClaim} — the
 * stale-takeover and `force` paths deliberately replace an existing file via
 * {@link writeWorktreeClaim} instead, since `touchWorktreeClaim` also relies on that
 * overwrite behaviour for its own claim.
 */
function createWorktreeClaimExclusive(shadowPath: string, claim: WorktreeClaim): boolean {
  const p = worktreeOwnerPath(shadowPath);
  try {
    writeFileSync(p, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Refresh mtime (and `at`) so other watches see we are still alive.
 *
 * Uses the same compare-and-swap discipline as {@link acquireWorktreeClaim}'s
 * stale-takeover path: re-read and recheck `id`+`at` immediately before writing, not
 * just once up front. Without that recheck, a touch that read the file just before an
 * operator's legitimate `force` override would still see the pre-override claim in
 * hand, and its write below would unconditionally restore it — reverting a live,
 * intentional takeover and leaving both processes believing they own the worktree
 * (with the new owner potentially already resetting it). Recheck-then-write closes that
 * window; on a mismatch we've lost ownership, so report that like any other loss.
 */
export function touchWorktreeClaim(shadowPath: string, processId: string): boolean {
  const current = readWorktreeClaim(shadowPath);
  if (!current || current.id !== processId) return false;
  const next: WorktreeClaim = { ...current, at: new Date().toISOString() };

  const recheck = readWorktreeClaim(shadowPath);
  if (!recheck || recheck.id !== processId || recheck.at !== current.at) return false;

  writeWorktreeClaim(shadowPath, next);
  try {
    const now = new Date();
    utimesSync(worktreeOwnerPath(shadowPath), now, now);
  } catch {
    /* write already refreshed content */
  }
  return true;
}

/**
 * Delete the owner file only if it still names this process.
 * Call this first during watch shutdown.
 */
export function releaseWorktreeClaim(shadowPath: string, processId: string): boolean {
  const p = worktreeOwnerPath(shadowPath);
  if (!existsSync(p)) return true;
  const current = readWorktreeClaim(shadowPath);
  if (current && current.id !== processId) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export type WorktreeAcquireResult =
  | { ok: true; claim: WorktreeClaim; forced?: boolean }
  | { ok: false; reason: "held"; claim: WorktreeClaim };

/** Bound on re-evaluate loops in {@link acquireWorktreeClaim} under heavy contention. */
const ACQUIRE_MAX_ATTEMPTS = 10;

/**
 * Claim the shared shadow worktree for this watch process.
 *
 * Acquire is atomic in the case that matters most for correctness — no existing claim —
 * via an exclusive (`O_EXCL`) create, so two processes racing to claim an unowned worktree
 * cannot both win. A stale or `force` takeover still replaces an existing file (there is no
 * portable atomic compare-and-swap for a plain file), but re-checks immediately before
 * writing that the claim it is about to replace hasn't just been taken by another process;
 * if it has, this call re-evaluates from scratch instead of clobbering the winner.
 *
 * @param force overwrite a live foreign claim (operator override).
 */
export function acquireWorktreeClaim(
  shadowPath: string,
  processId: string,
  opts: { force?: boolean } = {},
): WorktreeAcquireResult {
  const { user, host } = identity();
  const buildClaim = (): WorktreeClaim => ({
    v: 1,
    id: processId,
    user,
    at: new Date().toISOString(),
    pid: process.pid,
    ...(host ? { host } : {}),
  });

  for (let attempt = 0; attempt < ACQUIRE_MAX_ATTEMPTS; attempt++) {
    const existing = readWorktreeClaim(shadowPath);

    if (!existing) {
      // No parseable claim on disk — try to create it exclusively.
      const mine = buildClaim();
      if (createWorktreeClaimExclusive(shadowPath, mine)) {
        return { ok: true, claim: mine };
      }
      // Lost an EEXIST race: another process created it between our read and our
      // write. Re-read and re-evaluate rather than assuming we know its state.
      continue;
    }

    if (existing.id === processId) {
      // Already ours (e.g. re-acquiring after a reconnect) — a plain refresh is safe.
      const mine = buildClaim();
      writeWorktreeClaim(shadowPath, mine);
      return { ok: true, claim: mine };
    }

    const active = isWorktreeClaimActive(shadowPath);
    if (active && !opts.force) {
      return { ok: false, reason: "held", claim: existing };
    }

    // Stale takeover or explicit force: deliberate replace. For the non-force stale
    // path, re-check right before writing that the claim we're replacing is still the
    // one we saw — if another watch already took it over (or refreshed it) since our
    // read, back off and re-evaluate instead of clobbering that winner.
    if (!opts.force) {
      const recheck = readWorktreeClaim(shadowPath);
      if (!recheck || recheck.id !== existing.id || recheck.at !== existing.at) {
        continue;
      }
    }

    const mine = buildClaim();
    writeWorktreeClaim(shadowPath, mine);
    // Read back immediately: if another process won a concurrent stale takeover and wrote
    // after us, we must recognize we lost rather than believe the write above made us the
    // owner (touchWorktreeClaim would eventually catch this too, but not until the next
    // touch interval — verifying here means we never act as owner in the meantime).
    const verify = readWorktreeClaim(shadowPath);
    if (!verify || verify.id !== processId) {
      continue;
    }
    return { ok: true, claim: mine, forced: Boolean(opts.force && existing.id !== processId) };
  }

  const fallback = readWorktreeClaim(shadowPath);
  return {
    ok: false,
    reason: "held",
    claim: fallback ?? { v: 1, id: "unknown", user: "unknown", at: new Date().toISOString() },
  };
}
