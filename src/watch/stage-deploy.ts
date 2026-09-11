/**
 * Local stage (app-ci) deploy for `chong watch`.
 *
 * Replaces git-pushing `main → stage` (which burned GitHub Actions minutes) with:
 *   1. a debounce countdown after origin/main moves
 *   2. `scripts/deploy-frontend.sh ci` from main-shadow at that tip
 *   3. advancing the **local** `stage` branch to that tip (tracking only — never pushed)
 *   4. S3 markers (`deployed-git-sha.txt` + `deployed-tree-sha.txt`) so a stray
 *      stage-branch CI run can no-op — and so watch can prefer the LIVE tip over a
 *      stale local branch / origin/prod when comparing the pipeline
 *   5. Discord via the notify-discord relay (same channel as FE CI)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureShadow, runEslintFix, tryAgentLintFix } from "./checks";
import {
  acquireDeployClaim,
  CLAIM_HEARTBEAT_MS,
  formatClaimHolder,
  heartbeatDeployClaim,
  readDeployClaim,
  releaseDeployClaim,
  writeS3ShaMarkerVerified,
  type DeployClaim,
} from "./deploy-claim";
import { appendDeployHistory, deployHistoryPath } from "./deploy-history";
import { formatLintSummary, isAgentableLintFailure, lintableChangedFiles, runEslint } from "./lint";
import { repo } from "./repo";
import { formatUnresolvedSummary, scanUnresolvedImports } from "./unresolved-imports";

export const DEPLOYED_SHA_KEY = "deployed-git-sha.txt";
export const DEPLOYED_TREE_KEY = "deployed-tree-sha.txt";
export const DEFAULT_DEPLOY_COOLDOWN_SEC = 60;
export const STAGE_TRACK_BRANCH = "stage";

const DISCORD_ENDPOINTS = [
  "https://notify-discord.42b.eu",
  "https://notify-discord.cf42-0e1.workers.dev",
];
const DISCORD_CHANNEL = "dev-events";

type GitRun = { ok: boolean; out: string; err: string };

async function git(args: string[], cwd: string): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

export type StageDeployResult = {
  action: "noop" | "deployed" | "fixed" | "blocked" | "error" | "deferred";
  message: string;
  sha?: string;
  /** Set when deferred because another watch holds the soft deploy claim. */
  claim?: DeployClaim;
};

/** Backup marker under .chong/ (local `stage` branch is the primary tracker). */
export function localDeployedShaPath(repoPath: string): string {
  return path.join(repoPath, ".chong", "stage-deployed-sha");
}

export function readLocalDeployedSha(repoPath: string): string | null {
  try {
    const raw = readFileSync(localDeployedShaPath(repoPath), "utf8").trim();
    return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function writeLocalDeployedSha(repoPath: string, sha: string): void {
  const p = localDeployedShaPath(repoPath);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${sha}\n`, "utf8");
}

/**
 * Point local `stage` at the deployed SHA (tracking only). Also writes the
 * `.chong` backup file. Does not touch origin/stage.
 */
export async function markLocalStageDeployed(
  repoPath: string,
  sha: string,
  stageBranch = STAGE_TRACK_BRANCH,
): Promise<string | null> {
  writeLocalDeployedSha(repoPath, sha);
  return repo.setLocalBranch(repoPath, stageBranch, sha);
}

/** True when this repo has the LynxCraft local stage deploy script. */
export function hasFrontendStageDeployScript(repoPath: string): boolean {
  return existsSync(path.join(repoPath, "scripts", "deploy-frontend.sh"));
}

/**
 * Per-repo settings from `<repo>/.chong/config.json`.
 *
 * Everything repo-specific belongs here rather than in a module constant. Before this,
 * the bucket was a hardcoded LynxCraft-FRONTEND constant and the SHA marker was
 * written unconditionally on every successful deploy — so pointing `chong watch` at a
 * second repo would overwrite FRONTEND's `deployed-git-sha.txt` with the other repo's SHA,
 * and FRONTEND's stage CI (which reads that marker to decide whether it can no-op) would
 * skip a deploy it should have run. The marker is now opt-in per repo.
 */
export type RepoDeployConfig = {
  /** Deploy command; overrides detection. */
  stageDeployCmd?: string;
  /** S3 bucket for the stage/app-ci deployed-SHA marker. Omit to skip the marker entirely. */
  stageDeployedShaBucket?: string;
  /**
   * S3 bucket for the production deployed-SHA marker. When set, `chong watch` prefers
   * this live tip over `origin/prod` for the prod lane (same recovery story as stage).
   */
  prodDeployedShaBucket?: string;
  /** Local prod deploy command; overrides detection. Omit to disable local prod deploys. */
  prodDeployCmd?: string;
};

/** Where a live deploy tip came from — S3 wins when the marker exists. */
export type LiveTipSource = "s3" | "local-branch" | "local-file" | "none";

export type LiveDeployTip = {
  commit: string | null;
  tree: string | null;
  source: LiveTipSource;
};

/**
 * Pure priority for "what is live": S3 markers beat local branch / file backups.
 * Extracted so unit tests can lock the order without mocking `aws s3`.
 */
export function selectLiveDeployTip(opts: {
  s3Commit: string | null;
  s3Tree: string | null;
  branchSha: string | null;
  fileSha: string | null;
}): LiveDeployTip {
  const s3Commit = opts.s3Commit?.toLowerCase() ?? null;
  const s3Tree = opts.s3Tree?.toLowerCase() ?? null;
  if (s3Commit || s3Tree) {
    return { commit: s3Commit, tree: s3Tree, source: "s3" };
  }
  if (opts.branchSha) {
    return { commit: opts.branchSha.toLowerCase(), tree: null, source: "local-branch" };
  }
  if (opts.fileSha) {
    return { commit: opts.fileSha.toLowerCase(), tree: null, source: "local-file" };
  }
  return { commit: null, tree: null, source: "none" };
}

export function loadRepoDeployConfig(repoPath: string): RepoDeployConfig {
  const cfgPath = path.join(repoPath, ".chong", "config.json");
  if (!existsSync(cfgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as RepoDeployConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A malformed config must not stop the TUI: fall back to detection.
    return {};
  }
}

/**
 * The bucket to write the SHA marker to, or null when this repo has none.
 *
 * Config only — no sniffing. This used to fall back to a hardcoded LynxCraft
 * bucket for any repo containing scripts/deploy-frontend.sh, which meant chong
 * shipped one project's infrastructure name and would write that project's
 * marker on behalf of a repo that merely had a similarly-named script. The repo
 * declares its own bucket in .chong/config.json; a repo that declares none gets
 * no marker, which is the safe default.
 */
export function stageDeployedShaBucket(repoPath: string): string | null {
  return loadRepoDeployConfig(repoPath).stageDeployedShaBucket?.trim() || null;
}

/** Production marker bucket, or null when this repo has none configured. */
export function prodDeployedShaBucket(repoPath: string): string | null {
  return loadRepoDeployConfig(repoPath).prodDeployedShaBucket?.trim() || null;
}

/** `deploy:stage` from the repo's own package.json, if it has one. */
function packageJsonStageDeploy(repoPath: string): string | null {
  const pkgPath = path.join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg?.scripts?.["deploy:stage"] ? "npm run deploy:stage" : null;
  } catch {
    return null;
  }
}

/**
 * Resolution order: explicit config, then the repo's own `deploy:stage` script, then the
 * LynxCraft FRONTEND script. Preferring `deploy:stage` is what makes this work on any repo
 * without a flag — the repo states how it deploys, in the place a reader looks first.
 */
export function defaultStageDeployCmd(repoPath: string): string | null {
  const configured = loadRepoDeployConfig(repoPath).stageDeployCmd?.trim();
  if (configured) return configured;

  if (hasFrontendStageDeployScript(repoPath)) {
    // No DEPLOY_S3_TOOL: the deploy script resolves it itself — s5cmd when installed,
    // else the aws CLI with a one-line install hint. Forcing aws here (which this did,
    // because s5cmd is often missing on laptops) pinned every chong deploy to the
    // slower tool even on machines that had s5cmd.
    // FORCE skips the tty prompt. CI=true makes pnpm non-interactive
    // (confirmModulesPurge). DEPLOY_SKIP_INSTALL=1 relies on the main-shadow
    // node_modules symlink — no reinstall in the worktree.
    return "CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 ./scripts/deploy-frontend.sh ci";
  }

  return packageJsonStageDeploy(repoPath);
}

/** `deploy:prod` from the repo's own package.json, if it has one. */
function packageJsonProdDeploy(repoPath: string): string | null {
  const pkgPath = path.join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg?.scripts?.["deploy:prod"] ? "npm run deploy:prod" : null;
  } catch {
    return null;
  }
}

/**
 * Command for a LOCAL prod deploy, or null when this repo has no way to do one.
 *
 * Null is meaningful: the TUI falls back to the original push-the-branch-only prompt
 * when there is nothing to run locally, rather than offering a choice it cannot honour.
 */
export function defaultProdDeployCmd(repoPath: string): string | null {
  const configured = loadRepoDeployConfig(repoPath).prodDeployCmd?.trim();
  if (configured) return configured;

  const pkg = packageJsonProdDeploy(repoPath);
  if (pkg) return pkg;

  if (hasFrontendStageDeployScript(repoPath)) {
    // Same flags as the stage command — FORCE skips the tty prompt, CI makes pnpm
    // non-interactive. The upload tool is auto-detected by the script.
    return "CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 ./scripts/deploy-frontend.sh prod";
  }

  return null;
}

/**
 * Create `<repo>/.chong/` and make sure git ignores it.
 *
 * chong writes per-repo state there (deployed-SHA backup, config, `new` worktrees), none
 * of which belongs in the watched repo's history — and committing it by accident in a
 * shared working tree is exactly the sort of thing that lands in someone else's commit.
 * Appends to `.gitignore` only when no existing rule already covers it, and never rewrites
 * what is there.
 */
export function ensureChongIgnored(repoPath: string): void {
  try {
    mkdirSync(path.join(repoPath, ".chong"), { recursive: true });
  } catch {
    return;
  }
  const gitignore = path.join(repoPath, ".gitignore");
  try {
    const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    const covered = existing
      .split("\n")
      .map((l) => l.trim())
      .some((l) =>
        [".chong", ".chong/", ".chong/*", "/.chong", "/.chong/", "/.chong/*"].includes(l),
      );
    if (covered) return;
    const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
    // `.chong/` holds two different kinds of thing, so the rule cannot be a blanket
    // ignore: state.json, stage-deployed-sha and wt/ are machine-local and must never be
    // committed, but config.json is deliberate per-repo configuration — which repo, which
    // deploy command, which marker bucket — and ignoring it would mean every clone and
    // every teammate silently loses it. The negation keeps state out and config in.
    appendFileSync(
      gitignore,
      `${prefix}\n# chong: machine-local state ignored, per-repo config committed.\n# The trailing /* matters: git does not descend into an ignored DIRECTORY, so a\n# negation for a file inside one is unreachable and config.json stays ignored.\n.chong/*\n!.chong/config.json\n`,
    );
  } catch {
    // Not fatal — worst case the user sees .chong/ as untracked.
  }
}

/** Resolve effective deploy command, or null if this repo can't local-deploy stage. */
export function resolveStageDeployCmd(repoPath: string, configured: string): string | null {
  const trimmed = configured.trim();
  if (trimmed) return trimmed;
  return defaultStageDeployCmd(repoPath);
}

export async function notifyDiscordStage(message: string): Promise<boolean> {
  const payload = JSON.stringify({ webhookUrl: DISCORD_CHANNEL, message });
  for (const endpoint of DISCORD_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (res.ok) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Cap so the Discord body stays under the 2000-char webhook limit. */
const DISCORD_COMMIT_LIST_LIMIT = 40;

/**
 * Build the stage-success Discord body in the same multi-line shape as FE CI:
 * header + fenced list of `- <short> <subject> (<author>)` lines.
 */
export async function formatStageDeployDiscordMessage(
  repoPath: string,
  tip: string,
  previousSha: string | null,
): Promise<string> {
  const header = "✅ FE stage (chong local) deployed! Included commits:";

  let commits =
    previousSha && previousSha.toLowerCase() !== tip.toLowerCase()
      ? await repo.logBetweenShas(repoPath, tip, previousSha, DISCORD_COMMIT_LIST_LIMIT + 1)
      : [];

  if (commits.length === 0) {
    const tipMeta = await repo.commitMeta(repoPath, tip);
    commits = tipMeta ? [tipMeta] : [];
  }

  const truncated = commits.length > DISCORD_COMMIT_LIST_LIMIT;
  const shown = truncated ? commits.slice(0, DISCORD_COMMIT_LIST_LIMIT) : commits;
  const lines =
    shown.length > 0
      ? shown.map((c) => `- ${c.short} ${c.subject} (${c.author || "unknown"})`)
      : ["- no commits in this push"];
  if (truncated) lines.push(`- … and more (showing ${DISCORD_COMMIT_LIST_LIMIT})`);

  return `${header}\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

async function writeS3Marker(bucket: string, key: string, value: string): Promise<string | null> {
  const verified = await writeS3ShaMarkerVerified(bucket, key, value.trim());
  if (verified.ok) return null;
  if (verified.mismatch) {
    return (
      verified.error ||
      `S3 marker read-back mismatch for ${key}: wrote ${verified.mismatch.expected.slice(0, 12)}… got ${verified.mismatch.actual?.slice(0, 12) ?? "(missing)"}…`
    );
  }
  return verified.error || `aws s3 cp failed for ${key}`;
}

/** Upload the commit marker; verifies read-back. */
export async function writeS3DeployedSha(bucket: string, sha: string): Promise<string | null> {
  return writeS3Marker(bucket, DEPLOYED_SHA_KEY, sha);
}

/**
 * Upload the tree marker — what the GitHub stage gate compares to decide it can no-op.
 *
 * It has to be the tree rather than the commit: `chong watch` promotes main → origin/main
 * by re-creating commits, so the same content is deployed under one sha from here and a
 * different sha from a CI run, and a sha comparison never matched. Trees are identical
 * for identical content, so both routes agree. Mirrors what FRONTEND's
 * scripts/deploy-frontend.sh writes, so either deploy path leaves the same marker.
 */
export async function writeS3DeployedTree(bucket: string, tree: string): Promise<string | null> {
  return writeS3Marker(bucket, DEPLOYED_TREE_KEY, tree);
}

async function alertMarkerMismatch(
  _target: "stage" | "prod",
  detail: string,
  note?: (msg: string) => void,
): Promise<void> {
  // Local only — Discord is reserved for successful deploys.
  note?.(`S3 marker write verify failed — ${detail}`);
}

/**
 * Soft-claim the deploy bucket. Returns a deferred result when another watch holds it.
 * Caller must `releaseDeployClaim` in a finally when acquire succeeds.
 */
async function claimOrDefer(
  bucket: string | null,
  sha: string,
  processId: string,
  target: "stage" | "prod",
  opts: { force?: boolean; onProgress?: (msg: string) => void },
): Promise<
  | { proceed: true; claim: DeployClaim | null; bucket: string | null }
  | { proceed: false; result: StageDeployResult }
> {
  if (!bucket) return { proceed: true, claim: null, bucket: null };

  const acquired = await acquireDeployClaim(bucket, sha, processId, {
    force: opts.force,
    onProgress: opts.onProgress,
  });

  if (acquired.ok) {
    if (acquired.forced) {
      opts.onProgress?.(`deploy ${target}: forced claim as ${formatClaimHolder(acquired.claim)}`);
    }
    return { proceed: true, claim: acquired.claim, bucket };
  }

  if (acquired.reason === "held") {
    return {
      proceed: false,
      result: {
        action: "deferred",
        message: `${target} deploy deferred — in progress by ${formatClaimHolder(acquired.claim)}`,
        sha,
        claim: acquired.claim,
      },
    };
  }

  if (acquired.reason === "verify") {
    const detail =
      acquired.error ||
      `claim verify failed (expected ${acquired.expected.id.slice(0, 8)}…)`;
    return {
      proceed: false,
      result: { action: "error", message: detail, sha },
    };
  }

  return {
    proceed: false,
    result: {
      action: "error",
      message: `deploy claim write failed: ${acquired.error}`,
      sha,
    },
  };
}

/** Re-check claim ownership just before the expensive upload; defer if we lost it. */
async function confirmClaimBeforeUpload(
  bucket: string | null,
  claim: DeployClaim | null,
  sha: string,
  target: "stage" | "prod",
  force: boolean,
): Promise<StageDeployResult | null> {
  if (!bucket || !claim) return null;
  const current = await readDeployClaim(bucket);
  if (current && current.id === claim.id) return null;
  if (force) return null;
  if (current) {
    return {
      action: "deferred",
      message: `${target} deploy deferred before upload — claim now held by ${formatClaimHolder(current)}`,
      sha,
      claim: current,
    };
  }
  return {
    action: "deferred",
    message: `${target} deploy deferred before upload — claim cleared by another writer`,
    sha,
  };
}

export async function readS3DeployedSha(bucket: string): Promise<string | null> {
  return readS3ShaMarker(bucket, DEPLOYED_SHA_KEY);
}

/** Read the tree marker the stage/prod CI gate compares (identical content ⇒ same tree). */
export async function readS3DeployedTree(bucket: string): Promise<string | null> {
  return readS3ShaMarker(bucket, DEPLOYED_TREE_KEY);
}

async function readS3ShaMarker(bucket: string, key: string): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  const proc = Bun.spawn(["aws", "s3", "cp", uri, "-", "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AWS_PAGER: "" },
  });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  if (code !== 0) return null;
  return /^[0-9a-f]{7,40}$/i.test(out) ? out.toLowerCase() : null;
}

/**
 * Best-known live stage tip.
 *
 * Prefer the S3 markers when a bucket is configured and reachable — that is what is
 * actually on app-ci, including deploys from another machine or from CI. Fall back to
 * the local `stage` branch, then the `.chong/stage-deployed-sha` file (the older
 * single-laptop tracker).
 *
 * When S3 wins with a commit SHA, local `stage` is advanced to match so the lane and
 * the on-disk backup stay consistent across restarts and teammates.
 */
export async function resolveLiveStageTip(
  repoPath: string,
  stageBranch = STAGE_TRACK_BRANCH,
): Promise<LiveDeployTip> {
  const markerBucket = stageDeployedShaBucket(repoPath);
  const [s3Commit, s3Tree, branchSha] = await Promise.all([
    markerBucket ? readS3DeployedSha(markerBucket) : Promise.resolve(null),
    markerBucket ? readS3DeployedTree(markerBucket) : Promise.resolve(null),
    repo.localSha(repoPath, stageBranch),
  ]);
  const fileSha = readLocalDeployedSha(repoPath);
  const live = selectLiveDeployTip({ s3Commit, s3Tree, branchSha, fileSha });

  if (live.commit) {
    // Keep local tracker + backup aligned with whatever won (S3 or recovered file).
    if (live.source === "s3" || live.source === "local-file" || !branchSha) {
      const err = await markLocalStageDeployed(repoPath, live.commit, stageBranch);
      if (err) writeLocalDeployedSha(repoPath, live.commit);
    } else if (live.source === "local-branch") {
      writeLocalDeployedSha(repoPath, live.commit);
    }
  }
  return live;
}

/**
 * Best-known live stage commit SHA (compat wrapper around {@link resolveLiveStageTip}).
 */
export async function resolveDeployedStageSha(
  repoPath: string,
  stageBranch = STAGE_TRACK_BRANCH,
): Promise<string | null> {
  return (await resolveLiveStageTip(repoPath, stageBranch)).commit;
}

/**
 * Best-known live production tip.
 *
 * Prefer S3 markers when `prodDeployedShaBucket` is set — local `origin/prod` can lag
 * a local/chong deploy that wrote the bucket but never pushed the git ref. Fall back
 * to null so the pipeline keeps using `origin/prod` (the older branch-based approach).
 */
export async function resolveLiveProdTip(repoPath: string): Promise<LiveDeployTip> {
  const markerBucket = prodDeployedShaBucket(repoPath);
  if (!markerBucket) {
    return { commit: null, tree: null, source: "none" };
  }
  const [s3Commit, s3Tree] = await Promise.all([
    readS3DeployedSha(markerBucket),
    readS3DeployedTree(markerBucket),
  ]);
  const live = selectLiveDeployTip({
    s3Commit,
    s3Tree,
    branchSha: null,
    fileSha: null,
  });
  if (live.commit) {
    // Advance local `prod` to the live tip when safe — display + promote prompts agree.
    const err = await repo.setLocalBranch(repoPath, "prod", live.commit);
    if (err) {
      // Lane tip still uses the S3 commit; local ref update is best-effort.
    }
  }
  return live;
}

export async function resolveDeployedProdSha(repoPath: string): Promise<string | null> {
  return (await resolveLiveProdTip(repoPath)).commit;
}

/** True when tip's commit or tree already matches a live deploy tip. */
export function liveTipCoversSha(
  live: LiveDeployTip,
  tipCommit: string,
  tipTree: string | null,
): boolean {
  const tip = tipCommit.toLowerCase();
  if (live.commit && live.commit === tip) return true;
  if (live.tree && tipTree && live.tree === tipTree.toLowerCase()) return true;
  return false;
}

async function runDeployCommand(
  shadowPath: string,
  cmd: string,
  historyFile?: string,
  opts: {
    /** When this returns true, kill the deploy process (lost soft claim). */
    shouldAbort?: () => boolean;
  } = {},
): Promise<{ ok: boolean; output: string; aborted?: boolean }> {
  // Use `bash -c` (not `-lc`): a login shell sources sdkman/zsh helpers that break
  // under macOS /bin/bash 3.2 (`${var^^}` bad substitution) and can hang on prompts.
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: shadowPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CI: "true",
      FORCE: "1",
      DEPLOY_SKIP_INSTALL: process.env.DEPLOY_SKIP_INSTALL ?? "1",
      SKIP_SOURCEMAP: process.env.SKIP_SOURCEMAP ?? "1",
      HOME: process.env.HOME ?? homedir(),
      // The deploy script logs one row per deploy. cwd is a throwaway shadow worktree,
      // so without this the row is written there and discarded with it.
      ...(historyFile ? { DEPLOY_HISTORY_FILE: historyFile } : {}),
    },
  });

  let aborted = false;
  const poll = setInterval(() => {
    if (!opts.shouldAbort?.()) return;
    aborted = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, 2_000);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearInterval(poll);
  const code = await proc.exited;
  const output = `${stdout}\n${stderr}`.trim();
  if (aborted) {
    return {
      ok: false,
      output: output || "aborted: lost deploy claim mid-upload",
      aborted: true,
    };
  }
  return { ok: code === 0, output };
}

/** Heartbeat the S3 claim while an upload runs; invoke onLost if stolen. */
function startClaimHeartbeat(
  bucket: string | null,
  claim: DeployClaim | null,
  onLost: () => void,
): () => void {
  if (!bucket || !claim) return () => {};
  let lost = false;
  const tick = async () => {
    if (lost) return;
    const ok = await heartbeatDeployClaim(bucket, claim);
    if (!ok) {
      lost = true;
      onLost();
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, CLAIM_HEARTBEAT_MS);
  void tick();
  return () => clearInterval(timer);
}

/**
 * ESLint the files changed between `baseSha` and HEAD in the shadow worktree.
 * When baseSha is null, skip the gate (first deploy).
 */
async function eslintGate(
  repoPath: string,
  shadowPath: string,
  remote: string,
  mainBranch: string,
  stageBranch: string,
  baseSha: string | null,
  tip: string,
  agent: boolean,
): Promise<StageDeployResult | null> {
  if (!baseSha) return null;

  const files = await lintableChangedFiles(git, shadowPath, baseSha, tip);
  if (files.length === 0) return null;

  let run = await runEslint(shadowPath, files);
  if (run.ok) return null;

  // Try --fix via the existing stage-diff helpers (uses origin/stage as base when present).
  const stageTip = await repo.tip(repoPath, remote, stageBranch);
  if (stageTip) {
    const fix = await runEslintFix(
      repoPath,
      shadowPath,
      remote,
      mainBranch,
      mainBranch,
      stageBranch,
    );
    if (fix.committed && fix.pushed) {
      return {
        action: "fixed",
        message: "eslint fix pushed to main — redeploy after tip moves",
        sha: tip,
      };
    }
    run = await runEslint(shadowPath, files);
    if (run.ok) return null;

    if (agent && isAgentableLintFailure(run.errors)) {
      const summary = [
        "ESLint errors before local stage deploy:",
        formatLintSummary(run.errors),
        "",
        run.output.slice(0, 4000),
      ].join("\n");
      const agentRes = await tryAgentLintFix(
        repoPath,
        shadowPath,
        summary,
        files,
        remote,
        mainBranch,
      );
      if (agentRes.fixed) {
        return {
          action: "fixed",
          message: "eslint agent fixed → pushed to main — redeploy after tip moves",
          sha: tip,
        };
      }
      return { action: "blocked", message: agentRes.message, sha: tip };
    }
  }

  const preview = formatLintSummary(run.errors).slice(0, 300);
  return {
    action: "blocked",
    message: `eslint blocks stage deploy${preview ? `: ${preview}` : ""}`,
    sha: tip,
  };
}

/**
 * Block the deploy when any import specifier resolves to no file on disk.
 *
 * This catches what neither the build nor the tests can: a **lazy** `import()` is resolved
 * only when its chunk is first requested, so `vite build` succeeds and ships a route that
 * renders a blank page on navigation. A deletion or rename sweep is the usual cause — the
 * dangling import lives in a file the commit never touched.
 *
 * Unlike `eslintGate` this does NOT diff against the last deployed SHA. Scoping it to
 * changed files would skip the importing file, which is exactly the one that matters. The
 * whole tree costs ~0.5s on a 1,700-file repo, so there is nothing to save.
 *
 * No auto-fix and no agent hand-off: the right repair is either restoring the deleted file
 * or removing its importer, and guessing between those is how a deploy ships the wrong one.
 */
async function unresolvedImportGate(
  shadowPath: string,
  tip: string,
): Promise<StageDeployResult | null> {
  let scan: ReturnType<typeof scanUnresolvedImports>;
  try {
    scan = scanUnresolvedImports(shadowPath);
  } catch (err) {
    // A gate that cannot run must not silently pass, but it also must not wedge the
    // pipeline over its own bug — surface it and let the deploy proceed to the other gates.
    const msg = err instanceof Error ? err.message : String(err);
    return { action: "blocked", message: `import scan failed: ${msg.slice(0, 160)}`, sha: tip };
  }

  if (scan.findings.length === 0) return null;

  const preview = formatUnresolvedSummary(scan.findings, 3).replace(/\n/g, " | ");
  return {
    action: "blocked",
    message: `${scan.findings.length} unresolved import(s) block stage deploy: ${preview.slice(0, 260)}`,
    sha: tip,
  };
}

/** Reset the shadow worktree to `sha` and give the deploy the same .env a manual run sees. */
async function prepareShadow(
  repoPath: string,
  sha: string,
  processId?: string,
): Promise<{ shadowPath?: string; error?: string }> {
  const shadow = await ensureShadow(repoPath, sha, processId ? { processId } : undefined);
  if (shadow.error) return { error: shadow.error };

  // Only `.env` — deliberately NOT `.env.local`. Vite loads .env.local after .env and it
  // wins, so copying it would let a developer's localhost values into a real deploy.
  const envSrc = path.join(repoPath, ".env");
  const envDst = path.join(shadow.shadowPath, ".env");
  if (existsSync(envSrc)) {
    try {
      await Bun.write(envDst, await Bun.file(envSrc).arrayBuffer());
    } catch {
      /* deploy script will warn */
    }
  }
  return { shadowPath: shadow.shadowPath };
}

/**
 * Build+upload PRODUCTION from a shadow worktree at `sha`, instead of pushing the `prod`
 * branch and letting GitHub Actions do it.
 *
 * `sha` is the stage lane tip — the same commit `promote()` would have pushed — so local
 * and remote prod deploys ship identical content and differ only in who runs the build.
 *
 * Soft-claims the prod marker bucket before uploading (same eventually-consistent race as
 * stage). Pass `force: true` to proceed even when another watch holds the claim.
 *
 * No eslint or unresolved-import gate here, unlike the stage path: this exact commit
 * already passed both on its way to stage, and re-running the agent auto-fix at
 * prod-promote time could mutate the tree at the worst possible moment.
 *
 * Advances the LOCAL `prod` ref only, never pushes it — pushing would trigger the CI prod
 * job and deploy the same content a second time. The deploy script writes the S3 markers
 * and the deploy-history row for us.
 */
export async function runLocalProdDeploy(
  repoPath: string,
  prodBranch: string,
  sha: string,
  deployCmd: string,
  opts: {
    onProgress?: (msg: string) => void;
    force?: boolean;
    /** Stable UUID for this `chong watch` process. */
    processId: string;
  },
): Promise<StageDeployResult> {
  const note = opts.onProgress ?? (() => {});
  const force = opts.force === true;
  note(`deploy prod: resetting shadow to ${sha.slice(0, 7)}…`);

  const live = await resolveLiveProdTip(repoPath);
  const tipTreeRes = await git(["rev-parse", `${sha}^{tree}`], repoPath);
  const tipTree = tipTreeRes.ok ? tipTreeRes.out.toLowerCase() : null;
  if (liveTipCoversSha(live, sha, tipTree)) {
    const refErr = await repo.setLocalBranch(repoPath, prodBranch, sha);
    if (refErr) {
      note(`deploy prod: already live, but local ${prodBranch} ref update failed`);
    }
    return {
      action: "noop",
      message: `production already at ${sha.slice(0, 7)}`,
      sha,
    };
  }

  const markerBucket = prodDeployedShaBucket(repoPath);
  const gate = await claimOrDefer(markerBucket, sha, opts.processId, "prod", {
    force,
    onProgress: note,
  });
  if (!gate.proceed) return gate.result;
  const heldClaim = gate.claim;

  let claimLost = false;
  const stopHeartbeat = startClaimHeartbeat(markerBucket, heldClaim, () => {
    claimLost = true;
    note("deploy prod: lost soft claim mid-upload — aborting");
  });

  try {
    const lost = await confirmClaimBeforeUpload(markerBucket, heldClaim, sha, "prod", force);
    if (lost) return lost;

    const shadow = await prepareShadow(repoPath, sha, opts.processId);
    if (shadow.error || !shadow.shadowPath) {
      return { action: "blocked", message: `shadow: ${shadow.error}`, sha };
    }

    const lost2 = await confirmClaimBeforeUpload(markerBucket, heldClaim, sha, "prod", force);
    if (lost2) return lost2;

    note(`deploy prod: running ${deployCmd}…`);
    const run = await runDeployCommand(shadow.shadowPath, deployCmd, deployHistoryPath(repoPath), {
      shouldAbort: () => claimLost && !force,
    });
    if (run.aborted) {
      return {
        action: "deferred",
        message: `prod deploy aborted — claim stolen mid-upload`,
        sha,
      };
    }
    if (!run.ok) {
      const tail = run.output.slice(-1500);
      return {
        action: "error",
        message: `prod deploy failed: ${tail.split("\n").slice(-3).join(" | ") || "non-zero exit"}`,
        sha,
      };
    }

    const refErr = await repo.setLocalBranch(repoPath, prodBranch, sha);
    if (refErr) {
      note(`deploy prod: live, but local ${prodBranch} ref update failed (${refErr.slice(0, 120)})`);
    }

    if (markerBucket) {
      const tipTree2 = tipTree ?? (await repo.treeOf(repoPath, sha));
      const shaErr = await writeS3DeployedSha(markerBucket, sha);
      if (shaErr) await alertMarkerMismatch("prod", shaErr, note);
      if (tipTree2) {
        const treeErr = await writeS3DeployedTree(markerBucket, tipTree2);
        if (treeErr) await alertMarkerMismatch("prod", treeErr, note);
      }
    }

    const tree = await repo.treeOf(repoPath, sha);
    appendDeployHistory(repoPath, {
      target: "prod-local",
      tree: tree ?? "unknown",
      commit: sha,
      who: (await repo.userName(repoPath)) ?? process.env.USER ?? "unknown",
    });

    const discordOk = await notifyDiscordStage(
      `✅ FE prod (chong local) deployed! ${sha.slice(0, 7)} — local \`${prodBranch}\` advanced, not pushed`,
    );
    if (!discordOk) note("deploy prod: Discord notify failed");

    return {
      action: "deployed",
      message: `deployed ${sha.slice(0, 7)} → production (local ${prodBranch} advanced, not pushed)`,
      sha,
    };
  } finally {
    stopHeartbeat();
    if (markerBucket && heldClaim) {
      const relErr = await releaseDeployClaim(markerBucket, heldClaim);
      if (relErr) note(`deploy prod: claim release failed (${relErr.slice(0, 80)})`);
    }
  }
}

/**
 * Lint (CI parity) then build+upload to the CI bucket from origin/main tip.
 * Does not push the `stage` git branch.
 *
 * Soft-claims the stage marker bucket before uploading so parallel `chong watch`
 * processes defer instead of racing the same bucket.
 */
export async function runLocalStageDeploy(
  repoPath: string,
  remote: string,
  mainBranch: string,
  stageBranch: string,
  deployCmd: string,
  opts: {
    agent?: boolean;
    importScan?: boolean;
    onProgress?: (msg: string) => void;
    processId: string;
  },
): Promise<StageDeployResult> {
  const tip = await repo.tip(repoPath, remote, mainBranch);
  if (!tip) return { action: "error", message: `could not resolve ${remote}/${mainBranch}` };

  const live = await resolveLiveStageTip(repoPath, stageBranch);
  const tipTreeRes = await git(["rev-parse", `${tip}^{tree}`], repoPath);
  const tipTree = tipTreeRes.ok ? tipTreeRes.out.toLowerCase() : null;
  if (liveTipCoversSha(live, tip, tipTree)) {
    if (live.commit !== tip.toLowerCase()) {
      await markLocalStageDeployed(repoPath, tip, stageBranch);
    }
    return { action: "noop", message: `stage already at ${tip.slice(0, 7)}`, sha: tip };
  }

  const already = live.commit;
  const note = opts.onProgress ?? (() => {});

  const markerBucket = stageDeployedShaBucket(repoPath);
  const gate = await claimOrDefer(markerBucket, tip, opts.processId, "stage", {
    onProgress: note,
  });
  if (!gate.proceed) return gate.result;
  const heldClaim = gate.claim;

  let claimLost = false;
  const stopHeartbeat = startClaimHeartbeat(markerBucket, heldClaim, () => {
    claimLost = true;
    note("deploy stage: lost soft claim mid-upload — aborting");
  });

  try {
    note(`deploy stage: resetting shadow to ${tip.slice(0, 7)}…`);

    const shadow = await ensureShadow(repoPath, tip, { processId: opts.processId });
    if (shadow.error) {
      return { action: "blocked", message: `shadow: ${shadow.error}`, sha: tip };
    }

    note("deploy stage: eslint gate…");
    const eslintResult = await eslintGate(
      repoPath,
      shadow.shadowPath,
      remote,
      mainBranch,
      stageBranch,
      already,
      tip,
      opts.agent !== false,
    );
    if (eslintResult) return eslintResult;

    if (opts.importScan !== false) {
      note("deploy stage: unresolved-import scan…");
      const importGate = await unresolvedImportGate(shadow.shadowPath, tip);
      if (importGate) return importGate;
    }

    const envSrc = path.join(repoPath, ".env");
    const envDst = path.join(shadow.shadowPath, ".env");
    if (existsSync(envSrc)) {
      try {
        await Bun.write(envDst, await Bun.file(envSrc).arrayBuffer());
      } catch {
        /* deploy script will warn */
      }
    }

    const lost = await confirmClaimBeforeUpload(markerBucket, heldClaim, tip, "stage", false);
    if (lost) return lost;

    note(`deploy stage: running ${deployCmd}…`);
    const run = await runDeployCommand(shadow.shadowPath, deployCmd, deployHistoryPath(repoPath), {
      shouldAbort: () => claimLost,
    });
    if (run.aborted) {
      return {
        action: "deferred",
        message: `stage deploy aborted — claim stolen mid-upload`,
        sha: tip,
      };
    }
    if (!run.ok) {
      const tail = run.output.slice(-1500);
      return {
        action: "error",
        message: `deploy failed: ${tail.split("\n").slice(-3).join(" | ") || "non-zero exit"}`,
        sha: tip,
      };
    }

    const refErr = await markLocalStageDeployed(repoPath, tip, stageBranch);
    if (refErr) {
      note(
        `deploy stage: live, but local ${stageBranch} ref update failed (${refErr.slice(0, 120)})`,
      );
    }

    if (markerBucket) {
      const s3Err = await writeS3DeployedSha(markerBucket, tip);
      if (s3Err) {
        note(`deploy stage: live, but S3 marker failed (${s3Err.slice(0, 120)})`);
        await alertMarkerMismatch("stage", s3Err, note);
      }
      const treeRes = await git(["rev-parse", `${tip}^{tree}`], repoPath);
      if (treeRes.ok && treeRes.out) {
        const treeErr = await writeS3DeployedTree(markerBucket, treeRes.out);
        if (treeErr) {
          note(`deploy stage: live, but S3 tree marker failed (${treeErr.slice(0, 120)})`);
          await alertMarkerMismatch("stage", treeErr, note);
        }
      } else {
        note(`deploy stage: live, but could not resolve tree for ${tip.slice(0, 7)}`);
      }
    }

    const discordOk = await notifyDiscordStage(
      await formatStageDeployDiscordMessage(repoPath, tip, already),
    );
    if (!discordOk) note("deploy stage: Discord notify failed");

    return {
      action: "deployed",
      message: `deployed ${tip.slice(0, 7)} → app-ci (local ${stageBranch} advanced, not pushed)`,
      sha: tip,
    };
  } finally {
    stopHeartbeat();
    if (markerBucket && heldClaim) {
      const relErr = await releaseDeployClaim(markerBucket, heldClaim);
      if (relErr) note(`deploy stage: claim release failed (${relErr.slice(0, 80)})`);
    }
  }
}
