/**
 * Multi-target deploys: a repo holding several independently deployable units
 * (lynxcraft-agents: ~15 Agent Engine agents, render-api, calendar-fn …).
 *
 * ONE convention: every deployable directory owns a `deploy.sh`. chong DISCOVERS targets
 * from tracked `<dir>/deploy.sh` files (depth <= 2) — target name is the dir path with `/`
 * turned into `-` — and runs `bash deploy.sh` with cwd = that dir and CHONG_TARGET,
 * CHONG_SHA, CHONG_REPO_ROOT in the environment. `targets` in `.chong/config.json` is only
 * an override list keyed by name (label, paths, auto, requires, verifyCmd, cmd), and an
 * entry with an explicit `cmd` and no `deploy.sh` is the escape hatch.
 *
 * Deliberate differences from the single stage/prod path:
 *   - NEVER automatic unless the target says `auto: true`. An agent engine has no staging
 *     copy, so a local deploy is a production change, and an update replaces the live
 *     container env with whatever the deploying machine holds.
 *   - Gated: deploy-phase repo checks (ruff, tests …) must pass in the clean shadow and
 *     the CI verdict for the SHA must not be red. Only an explicit `--force-gate` skips.
 *   - Only commits already on `<remote>/<main>` can be deployed.
 *   - Remote bookkeeping (deployed-SHA marker + soft claim = who deploys what) lives per
 *     target in `targetMarkerBucket` under `<prefix><target>/`; without a bucket the local
 *     `.chong/deployed/<name>` record is the only state.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { c } from "../util";
import { ensureShadow } from "./checks";
import {
  CLAIM_HEARTBEAT_MS,
  type DeployClaim,
  acquireDeployClaim,
  formatClaimHolder,
  heartbeatDeployClaim,
  isClaimStale,
  readDeployClaim,
  readS3Text,
  releaseDeployClaim,
  writeS3ShaMarkerVerified,
} from "./deploy-claim";
import { appendDeployHistory } from "./deploy-history";
import { repo } from "./repo";
import { checksForPhase, detectRepoProfile } from "./repo-profile";
import { anyFailed, runChecks } from "./run-checks";
import {
  type DeployTarget,
  FORBIDDEN_CMD_CHARS,
  linkVenv,
  loadRepoDeployConfig,
  startClaimHeartbeat,
  validateMarkerBucketName,
} from "./stage-deploy";
import {
  WORKTREE_CLAIM_TOUCH_MS,
  releaseWorktreeClaim,
  touchWorktreeClaim,
} from "./worktree-claim";

export type { DeployTarget } from "./stage-deploy";

// --no-sync: the shadow .venv is a symlink to the shared one; a deploy must not mutate it.
export const UV_RUN = "uv run --frozen --no-sync";
export const TARGET_SHA_KEY = "deployed-git-sha.txt";
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SKIP_DIRS = new Set(["node_modules", ".venv", ".git", ".chong", "__pycache__", "dist"]);

// ── config ──────────────────────────────────────────────────────────────────

/** A repo-relative path that stays inside the repo (no absolute, `..`, or pathspec magic). */
function isSafeRelPath(p: string): boolean {
  if (!p || path.isAbsolute(p) || p.startsWith(":") || p.startsWith("-")) return false;
  return !p.split(/[\\/]/).includes("..");
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validate the `targets` override list from the (committed, therefore untrusted) repo
 * config. Invalid entries are dropped with an error each; one bad entry must not hide the rest.
 */
export function validateTargets(raw: unknown): { targets: DeployTarget[]; errors: string[] } {
  const errors: string[] = [];
  const targets: DeployTarget[] = [];
  if (raw === undefined || raw === null) return { targets, errors };
  // Either `[{ name, ... }]` or `{ "<name>": { ... } }` (override map keyed by target name).
  if (!Array.isArray(raw) && typeof raw === "object") {
    raw = Object.entries(raw as Record<string, unknown>).map(([name, v]) => ({
      ...(v && typeof v === "object" ? v : {}),
      name,
    }));
  }
  if (!Array.isArray(raw)) {
    return { targets, errors: ["targets must be an array or an object keyed by target name"] };
  }
  const seen = new Set<string>();
  raw.forEach((t, i) => {
    const o = t as Record<string, unknown> | null;
    const label = typeof o?.name === "string" ? `target "${o.name}"` : `targets[${i}]`;
    const fail = (why: string) => errors.push(`${label}: ${why}`);
    if (!o || typeof o !== "object") return fail("not an object");
    if (typeof o.name !== "string" || !NAME_RE.test(o.name)) {
      return fail("name must match ^[a-z0-9][a-z0-9_-]*$");
    }
    if (seen.has(o.name)) return fail("duplicate name");
    for (const key of ["cmd", "verifyCmd"] as const) {
      const v = o[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || !v.trim()) return fail(`${key} must be a non-empty string`);
      const m = v.match(FORBIDDEN_CMD_CHARS);
      if (m) return fail(`${key} contains forbidden shell metacharacter ${JSON.stringify(m[0])}`);
    }
    if (o.paths !== undefined && !(isStringArray(o.paths) && o.paths.every(isSafeRelPath))) {
      return fail("paths must be repo-relative strings without '..', ':' or leading '-'");
    }
    if (o.envFile !== undefined && (typeof o.envFile !== "string" || !isSafeRelPath(o.envFile))) {
      return fail("envFile must be a repo-relative path");
    }
    if (o.requires !== undefined && !isStringArray(o.requires)) {
      return fail("requires must be an array of check names");
    }
    if (o.label !== undefined && typeof o.label !== "string") return fail("label must be a string");
    seen.add(o.name);
    targets.push({
      name: o.name,
      ...(typeof o.cmd === "string" ? { cmd: o.cmd.trim() } : {}),
      ...(o.paths ? { paths: o.paths as string[] } : {}),
      ...(o.envFile ? { envFile: o.envFile as string } : {}),
      ...(o.auto === true ? { auto: true } : {}),
      ...(typeof o.label === "string" ? { label: o.label } : {}),
      ...(o.requires ? { requires: o.requires as string[] } : {}),
      ...(typeof o.verifyCmd === "string" ? { verifyCmd: o.verifyCmd.trim() } : {}),
    });
  });
  return { targets, errors };
}

/** `a/b/deploy.sh` -> `{ dir: "a/b", name: "a-b" }` for depth 1-2; null otherwise. */
export function targetFromDeployScript(file: string): { dir: string; name: string } | null {
  const parts = file.split("/");
  if (parts.length < 2 || parts.length > 3 || parts[parts.length - 1] !== "deploy.sh") return null;
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => d.startsWith(".") || SKIP_DIRS.has(d))) return null;
  return { dir: dirs.join("/"), name: dirs.join("-") };
}

/**
 * Pure merge of discovered `deploy.sh` files with config overrides.
 * Default stale-paths: the target's own dir (an override's `paths` replaces it) plus
 * `sharedPaths`, which always apply.
 */
export function mergeTargets(
  deployScripts: string[],
  overrides: DeployTarget[],
  opts: { sharedPaths?: string[]; ignore?: string[] } = {},
): { targets: DeployTarget[]; errors: string[] } {
  const errors: string[] = [];
  const shared = opts.sharedPaths ?? [];
  const ignore = new Set(opts.ignore ?? []);
  const byName = new Map(overrides.map((o) => [o.name, o]));
  const out = new Map<string, DeployTarget>();

  for (const file of [...deployScripts].sort()) {
    const d = targetFromDeployScript(file);
    if (!d || ignore.has(d.name) || ignore.has(d.dir)) continue;
    if (!NAME_RE.test(d.name)) {
      errors.push(
        `${file}: target name "${d.name}" must match ^[a-z0-9][a-z0-9_-]*$ (rename the dir or add it to ignoreTargets)`,
      );
      continue;
    }
    if (out.has(d.name)) {
      errors.push(`${file}: target name "${d.name}" collides with another deploy.sh`);
      continue;
    }
    const o = byName.get(d.name);
    out.set(d.name, {
      ...o,
      name: d.name,
      dir: d.dir,
      paths: [...(o?.paths ?? [d.dir]), ...shared],
    });
  }
  for (const o of overrides) {
    if (out.has(o.name) || ignore.has(o.name)) continue;
    if (!o.cmd) {
      errors.push(`target "${o.name}": no ${o.name.replace(/-/g, "/")}/deploy.sh found and no cmd`);
      continue;
    }
    out.set(o.name, { ...o, ...(o.paths ? { paths: [...o.paths, ...shared] } : {}) });
  }
  return { targets: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

async function trackedDeployScripts(repoPath: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "-z", "--", "*/deploy.sh", "*/*/deploy.sh"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export async function resolveDeployTargets(
  repoPath: string,
): Promise<{ targets: DeployTarget[]; errors: string[] }> {
  const cfg = loadRepoDeployConfig(repoPath);
  const v = validateTargets(cfg.targets);
  const errors = [...v.errors];
  let shared: string[] = [];
  if (cfg.sharedPaths !== undefined) {
    if (isStringArray(cfg.sharedPaths) && cfg.sharedPaths.every(isSafeRelPath))
      shared = cfg.sharedPaths;
    else errors.push("sharedPaths must be repo-relative strings without '..', ':' or leading '-'");
  }
  const ignore = isStringArray(cfg.ignoreTargets) ? cfg.ignoreTargets : [];
  const merged = mergeTargets(await trackedDeployScripts(repoPath), v.targets, {
    sharedPaths: shared,
    ignore,
  });
  return { targets: merged.targets, errors: [...errors, ...merged.errors] };
}

// ── marker bucket ───────────────────────────────────────────────────────────

export type TargetMarkerConfig = { bucket: string; prefix: string };

/** Validated per-target marker bucket + key prefix (default `<repoDirName>/`), or null. */
export function targetMarkerConfig(repoPath: string): TargetMarkerConfig | null {
  const cfg = loadRepoDeployConfig(repoPath);
  if (!cfg.targetMarkerBucket) return null;
  const bucket = validateMarkerBucketName(repoPath, "targetMarkerBucket", cfg.targetMarkerBucket);
  if (!bucket) return null;
  let prefix = cfg.targetMarkerPrefix?.trim() || `${path.basename(repoPath)}/`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix) || prefix.split("/").includes("..")) {
    console.error(
      c.red(
        `chong: refusing .chong/config.json "targetMarkerPrefix" (${repoPath}) — "${prefix}" is not a plain key prefix.`,
      ),
    );
    return null;
  }
  if (!prefix.endsWith("/")) prefix += "/";
  return { bucket, prefix };
}

/** `<prefix><target>/` — the key prefix of one target's claim and marker. */
export function targetKeyPrefix(prefix: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid target name: ${name}`);
  return `${prefix}${name}/`;
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

export async function readRemoteDeployedSha(
  m: TargetMarkerConfig,
  name: string,
): Promise<string | null> {
  const raw = await readS3Text(m.bucket, `${targetKeyPrefix(m.prefix, name)}${TARGET_SHA_KEY}`);
  const t = raw?.trim() ?? "";
  return HEX_SHA.test(t) ? t.toLowerCase() : null;
}

// ── env file ────────────────────────────────────────────────────────────────

/**
 * Parse a dotenv-style file: `KEY=VALUE`, optional `export `, `#` comments, single quotes
 * (literal), double quotes (`\n`, `\"`, `\\` escapes), unquoted values end at ` #`.
 * Never evaluated by a shell, so `$(…)` in a value is just text.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    let value: string;
    if (rest.startsWith('"')) {
      const inner = rest.slice(1);
      const end = inner.search(/(?<!\\)"/);
      const body = end >= 0 ? inner.slice(0, end) : inner;
      value = body.replace(/\\(n|"|\\)/g, (_, ch: string) => (ch === "n" ? "\n" : ch));
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end > 0 ? rest.slice(1, end) : rest.slice(1);
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
    }
    env[key] = value;
  }
  return env;
}

/** Read the target's env file from the SOURCE repo (it is git-ignored, so absent from shadows). */
export function readTargetEnv(
  repoPath: string,
  target: DeployTarget,
): { env: Record<string, string>; error?: string } {
  if (!target.envFile) return { env: {} };
  const file = path.join(repoPath, target.envFile);
  if (!existsSync(file)) return { env: {}, error: `envFile ${target.envFile} not found` };
  try {
    return { env: parseEnvFile(readFileSync(file, "utf8")) };
  } catch (e) {
    return { env: {}, error: `envFile ${target.envFile}: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * Keep the full (already redacted) output of a failed deploy under ~/.chong/logs. The
 * status line only has room for the last few lines, which is rarely where a traceback's
 * cause is. Best effort: a log that cannot be written must not mask the deploy failure.
 */
function writeDeployLog(target: string, sha: string, text: string): string | null {
  try {
    const dir = path.join(homedir(), ".chong", "logs");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `deploy-${target}-${sha.slice(0, 7)}.log`);
    writeFileSync(file, `${text}\n`, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** Remove every env-file value from text bound for the terminal. */
export function redactValues(text: string, env: Record<string, string>): string {
  let out = text;
  for (const v of Object.values(env)) {
    if (v.length >= 6) out = out.split(v).join("***");
  }
  return out;
}

// ── deployed record + staleness ─────────────────────────────────────────────

export function deployedRecordPath(repoPath: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid target name: ${name}`);
  return path.join(repoPath, ".chong", "deployed", name);
}

export function readDeployedSha(repoPath: string, name: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(deployedRecordPath(repoPath, name), "utf8")) as {
      sha?: unknown;
    };
    return typeof parsed.sha === "string" && HEX_SHA.test(parsed.sha)
      ? parsed.sha.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function writeDeployedSha(repoPath: string, name: string, sha: string, who: string): void {
  const p = deployedRecordPath(repoPath, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ sha, at: new Date().toISOString(), who })}\n`, "utf8");
}

export type Staleness = { stale: boolean; deployedSha: string | null; reason: string };

/** Pure: interpret a `git diff --name-only deployed..tip -- <paths>` result. */
export function interpretStaleness(
  deployedSha: string | null,
  diff: { ok: boolean; out: string },
): Staleness {
  if (!deployedSha) return { stale: true, deployedSha, reason: "never deployed" };
  if (!diff.ok) return { stale: true, deployedSha, reason: "deployed SHA not comparable" };
  const n = diff.out.split("\n").filter(Boolean).length;
  return n > 0
    ? { stale: true, deployedSha, reason: `${n} changed file${n === 1 ? "" : "s"}` }
    : { stale: false, deployedSha, reason: "up to date" };
}

export type TargetStatus = Staleness & {
  source: "s3" | "local" | "none";
  /** Live (non-stale) claim, i.e. someone is deploying this target right now. */
  claim: DeployClaim | null;
};

/** Staleness vs the REMOTE deployed sha when a marker bucket is configured, else the local record. */
export async function targetStatus(
  repoPath: string,
  target: DeployTarget,
  tip: string,
): Promise<TargetStatus> {
  const marker = targetMarkerConfig(repoPath);
  let deployed: string | null = null;
  let source: TargetStatus["source"] = "none";
  let claim: DeployClaim | null = null;
  if (marker) {
    const [sha, cl] = await Promise.all([
      readRemoteDeployedSha(marker, target.name),
      readDeployClaim(marker.bucket, targetKeyPrefix(marker.prefix, target.name)),
    ]);
    if (sha) {
      deployed = sha;
      source = "s3";
    }
    if (cl && !isClaimStale(cl)) claim = cl;
  }
  if (!deployed) {
    deployed = readDeployedSha(repoPath, target.name);
    if (deployed) source = "local";
  }
  if (!deployed) return { ...interpretStaleness(null, { ok: true, out: "" }), source, claim };

  const args = ["diff", "--name-only", `${deployed}..${tip}`];
  if (target.paths?.length) args.push("--", ...target.paths);
  const proc = Bun.spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { ...interpretStaleness(deployed, { ok: code === 0, out: out.trim() }), source, claim };
}

// ── gate ────────────────────────────────────────────────────────────────────

export type CiVerdict = "success" | "failure" | "none";

/**
 * Pure mirror of lynxcraft-agents `scripts/ci_result_for_sha.sh`: a passing run wins; any
 * run still going means "wait"; otherwise a failed run is red; anything else is no verdict.
 * Lines are `<status>/<conclusion>` as `gh run list --jq` prints them.
 */
export function ciVerdictFromRuns(lines: string[]): CiVerdict | "pending" {
  const l = lines.filter(Boolean);
  if (l.includes("completed/success")) return "success";
  if (l.some((x) => !x.startsWith("completed/"))) return "pending";
  if (l.includes("completed/failure")) return "failure";
  return "none";
}

async function ghRunLines(cwd: string, sha: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(
      [
        "gh",
        "run",
        "list",
        "--workflow",
        "ci.yml",
        "--commit",
        sha,
        "--limit",
        "20",
        "--json",
        "status,conclusion",
        "--jq",
        '.[] | "\\(.status)/\\(.conclusion)"',
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.split("\n") : null;
  } catch {
    return null;
  }
}

export async function ciVerdictForSha(
  repoPath: string,
  sha: string,
  opts: { maxWaitSec?: number; pollSec?: number; onProgress?: (m: string) => void } = {},
): Promise<CiVerdict> {
  const maxWait = opts.maxWaitSec ?? 600;
  const poll = opts.pollSec ?? 20;
  let waited = 0;
  for (;;) {
    const lines = await ghRunLines(repoPath, sha);
    if (!lines) return "none";
    const v = ciVerdictFromRuns(lines);
    if (v !== "pending") return v;
    if (waited >= maxWait) return "none";
    opts.onProgress?.(`CI for ${sha.slice(0, 7)} still running (${waited}s of ${maxWait}s)`);
    await new Promise((r) => setTimeout(r, poll * 1000));
    waited += poll;
  }
}

export type GateInput = {
  /** Local deploy-phase checks: null = none configured. */
  checks: { ok: boolean; summary: string } | null;
  ci: CiVerdict;
  /** Is the SHA reachable from <remote>/<main>? */
  onRemote: boolean;
  forceGate: boolean;
};

export type GatePlan = { allow: boolean; reasons: string[]; warnings: string[] };

/** Pure decision: may this SHA be deployed? `forceGate` downgrades gate failures to warnings. */
export function planDeploy(i: GateInput): GatePlan {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!i.onRemote) reasons.push("SHA is not on the remote main branch (push it first)");
  const gate: string[] = [];
  if (i.checks && !i.checks.ok) gate.push(`checks failed: ${i.checks.summary}`);
  if (i.ci === "failure") gate.push("CI is red for this commit");
  if (i.forceGate) warnings.push(...gate.map((g) => `${g} (bypassed by --force-gate)`));
  else reasons.push(...gate);
  if (!i.checks && i.ci === "none") {
    warnings.push("no checks configured and no CI result: nothing verified this commit");
  }
  return { allow: reasons.length === 0, reasons, warnings };
}

export type GateDeps = {
  /** Run the deploy-phase repo checks in `shadowPath`; null when none are configured. */
  runChecks: (
    shadowPath: string,
    target: DeployTarget,
  ) => Promise<{ ok: boolean; summary: string } | null>;
  ci: (sha: string) => Promise<CiVerdict>;
};

/**
 * Real gate: deploy-phase checks over the whole shadow tree (`requires` narrows them by
 * name) and the `ci.yml` verdict via `gh`.
 */
export function defaultGateDeps(repoPath: string, onProgress?: (m: string) => void): GateDeps {
  return {
    runChecks: async (shadowPath, target) => {
      let checks = checksForPhase(detectRepoProfile(shadowPath).checks, "deploy");
      if (target.requires) checks = checks.filter((ck) => target.requires?.includes(ck.name));
      if (checks.length === 0) return null;
      const results = await runChecks(shadowPath, checks, {
        phase: "deploy",
        env: { CHONG_TARGET: target.name },
      });
      const failed = results.filter((r) => r.status === "fail");
      return {
        ok: !anyFailed(results),
        summary: failed
          .map((r) => `${r.name}: ${r.detail.split("\n").slice(-6).join(" | ")}`)
          .join("; "),
      };
    },
    ci: (sha) => ciVerdictForSha(repoPath, sha, { onProgress }),
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function runShell(
  cwd: string,
  cmd: string,
  env: Record<string, string>,
  shouldAbort?: () => boolean,
): Promise<{ ok: boolean; output: string; aborted?: boolean }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...process.env, HOME: process.env.HOME ?? homedir(), ...env },
  });
  let aborted = false;
  const kill = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      /* group already gone */
    }
  };
  const poll = setInterval(() => {
    if (aborted || !shouldAbort?.()) return;
    aborted = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 5_000).unref();
  }, 2_000);
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0 && !aborted, output: `${out}\n${err}`.trim(), aborted };
  } finally {
    clearInterval(poll);
  }
}

export type TargetDeployResult = {
  action: "deployed" | "noop" | "blocked" | "error" | "deferred";
  message: string;
  sha?: string;
  claim?: DeployClaim;
};

export async function runTargetDeploy(
  repoPath: string,
  remote: string,
  mainBranch: string,
  sha: string,
  target: DeployTarget,
  opts: {
    processId?: string;
    forceGate?: boolean;
    gate: GateDeps;
    onProgress?: (msg: string) => void;
  },
): Promise<TargetDeployResult> {
  const note = opts.onProgress ?? (() => {});
  const processId = opts.processId ?? randomUUID();
  const short = sha.slice(0, 7);
  if (!target.cmd && !target.dir) {
    return {
      action: "blocked",
      message: `${target.name}: nothing to run (no deploy.sh, no cmd)`,
      sha,
    };
  }

  const anc = Bun.spawn(["git", "merge-base", "--is-ancestor", sha, `${remote}/${mainBranch}`], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const onRemote = (await anc.exited) === 0;

  const envRes = readTargetEnv(repoPath, target);
  if (envRes.error) return { action: "blocked", message: envRes.error, sha };

  // Remote claim first: refuse before touching any worktree when someone else is deploying.
  const marker = targetMarkerConfig(repoPath);
  const keyPrefix = marker ? targetKeyPrefix(marker.prefix, target.name) : null;
  let claim: DeployClaim | null = null;
  let claimLost = false;
  let stopHeartbeat = () => {};
  if (marker && keyPrefix) {
    const acq = await acquireDeployClaim(marker.bucket, sha, processId, {
      prefix: keyPrefix,
      onProgress: note,
    });
    if (!acq.ok) {
      if (acq.reason === "held") {
        return {
          action: "deferred",
          message: `${target.name}: deploy in progress by ${formatClaimHolder(acq.claim)}`,
          sha,
          claim: acq.claim,
        };
      }
      const why =
        acq.reason === "verify"
          ? (acq.error ?? "claim verify failed")
          : acq.reason === "write"
            ? acq.error
            : "no bucket";
      return { action: "error", message: `${target.name}: deploy claim failed: ${why}`, sha };
    }
    claim = acq.claim;
    stopHeartbeat = startClaimHeartbeat(
      marker.bucket,
      claim,
      () => {
        claimLost = true;
        note(`${target.name}: lost deploy claim — aborting`);
      },
      {
        heartbeat: (b, cl) => heartbeatDeployClaim(b, cl, keyPrefix),
        intervalMs: CLAIM_HEARTBEAT_MS,
        onProgress: note,
      },
    );
  }

  note(`${target.name}: resetting shadow to ${short}…`);
  const shadow = await ensureShadow(repoPath, sha, { processId, role: `target-${target.name}` });
  const shadowPath = shadow.shadowPath;
  const touch = setInterval(
    () => touchWorktreeClaim(shadowPath, processId),
    WORKTREE_CLAIM_TOUCH_MS,
  );
  try {
    if (shadow.error) {
      return { action: "blocked", message: `shadow: ${shadow.error}`, sha };
    }
    linkVenv(repoPath, shadowPath);

    note(`${target.name}: running checks…`);
    const checks = await opts.gate.runChecks(shadowPath, target);
    note(`${target.name}: checking CI for ${short}…`);
    const ci = await opts.gate.ci(sha);
    const plan = planDeploy({ checks, ci, onRemote, forceGate: opts.forceGate === true });
    for (const w of plan.warnings) note(`${target.name}: ⚠ ${w}`);
    if (!plan.allow) {
      return { action: "blocked", message: `gate refused: ${plan.reasons.join("; ")}`, sha };
    }

    const cwd = target.dir ? path.join(shadowPath, target.dir) : shadowPath;
    const env = {
      ...envRes.env,
      CHONG_TARGET: target.name,
      CHONG_SHA: sha,
      CHONG_REPO_ROOT: shadowPath,
    };
    note(`${target.name}: deploying ${short}…`);
    const run = await runShell(cwd, effectiveTargetCmd(repoPath, target), env, () => claimLost);
    if (run.aborted) {
      return { action: "deferred", message: `${target.name}: aborted — deploy claim stolen`, sha };
    }
    if (!run.ok) {
      const redacted = redactValues(run.output, envRes.env);
      const tail = redacted.split("\n").slice(-4).join(" | ");
      const logPath = writeDeployLog(target.name, sha, redacted);
      const where = logPath ? ` (full log: ${logPath})` : "";
      return { action: "error", message: `deploy failed${where}: ${tail || "non-zero exit"}`, sha };
    }
    if (target.verifyCmd) {
      note(`${target.name}: verifying…`);
      const v = await runShell(cwd, target.verifyCmd, env);
      if (!v.ok) {
        const tail = redactValues(v.output, envRes.env).split("\n").slice(-4).join(" | ");
        return {
          action: "error",
          message: `deployed, but verify failed (not recorded as deployed): ${tail}`,
          sha,
        };
      }
    }

    const who = (await repo.userName(repoPath)) ?? process.env.USER ?? "unknown";
    writeDeployedSha(repoPath, target.name, sha, who);
    if (marker && keyPrefix) {
      const w = await writeS3ShaMarkerVerified(marker.bucket, `${keyPrefix}${TARGET_SHA_KEY}`, sha);
      if (!w.ok)
        note(`${target.name}: ⚠ remote marker write failed (${w.error ?? "read-back mismatch"})`);
    }
    try {
      appendDeployHistory(repoPath, {
        target: target.name,
        tree: (await repo.treeOf(repoPath, sha)) ?? "unknown",
        commit: sha,
        who,
      });
    } catch {
      /* history is bookkeeping */
    }
    return {
      action: "deployed",
      message: `${target.name} deployed ${short}${target.label ? ` → ${target.label}` : ""}`,
      sha,
    };
  } finally {
    clearInterval(touch);
    releaseWorktreeClaim(shadowPath, processId);
    stopHeartbeat();
    if (marker && keyPrefix && claim) await releaseDeployClaim(marker.bucket, claim, keyPrefix);
  }
}

/**
 * The command a target runs. An explicit `cmd` wins. Otherwise `bash deploy.sh`, wrapped in
 * `uv run` for a uv-managed Python repo (so the project `.venv` leads PATH, as `pnpm` does
 * for FRONTEND, and deploy scripts that check the pickler venv see the pinned one).
 */
export function effectiveTargetCmd(repoPath: string, target: DeployTarget): string {
  if (target.cmd) return target.cmd;
  const uvRepo =
    detectRepoProfile(repoPath).kind === "python" && existsSync(path.join(repoPath, "uv.lock"));
  return uvRepo ? `${UV_RUN} bash deploy.sh` : "bash deploy.sh";
}

/** One-line description used by confirm prompts and the CLI. */
export function describeTarget(t: DeployTarget): string {
  return `${t.name}${t.label ? ` (${t.label})` : ""}`;
}

/** Status for list output: fresh/stale, deployed sha + source, and the live claim holder. */
export function formatStatus(s: TargetStatus): string {
  const sha = s.deployedSha ? s.deployedSha.slice(0, 7) : "—";
  const src = s.source === "none" ? "" : ` ${s.source}`;
  const head = s.stale
    ? `${c.yellow("stale")} ${c.dim(`${sha}${src} · ${s.reason}`)}`
    : `${c.green("fresh")} ${c.dim(`${sha}${src}`)}`;
  return s.claim ? `${head} ${c.cyan(`⏳ ${formatClaimHolder(s.claim)}`)}` : head;
}
