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
import { c } from "../util";
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
 * S3 bucket-name grammar enforced on a CONFIGURED marker bucket.
 *
 * `.chong/config.json` is deliberately committed to each watched repo (see the comment on
 * {@link rejectUnsafeConfiguredCmd}), so `stageDeployedShaBucket` / `prodDeployedShaBucket`
 * are repo-controlled. There is no argv-injection risk here — the value lands in one
 * `s3://<bucket>/<key>` argv element, so shell metacharacters just make a malformed URI, not
 * an extra flag — but a repo-chosen bucket name still redirects two things that matter:
 *
 *   - WRITES (`writeS3DeployedSha` / `writeDeployClaim`): a compromised repo can send the
 *     deployed SHA and the operator's user/host to any bucket the operator can write to —
 *     cross-project marker corruption, plus a cheap exfiltration channel.
 *   - READS: `selectLiveDeployTip` treats the S3 marker as authoritative over local refs, and
 *     `liveTipCoversSha` uses it to decide whether a commit still needs deploying. A bucket
 *     that echoes back the current tip makes chong believe prod already ships that commit and
 *     silently skip the deploy.
 *
 * This validates FORMAT only: `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$` (3-63 chars, lowercase
 * letters/digits/dots/hyphens, must start and end with a letter or digit), plus the two other
 * shapes S3 itself rejects — `..` and an IP-address-looking name. A validly-named bucket the
 * attacker actually owns still passes: this is hygiene against malformed/abusive values, not a
 * trust boundary around bucket ownership. The owner explicitly chose format validation over
 * prompting on change.
 */
const S3_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IP_ADDRESS_LIKE_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isValidMarkerBucketName(name: string): boolean {
  return S3_BUCKET_NAME_RE.test(name) && !name.includes("..") && !IP_ADDRESS_LIKE_RE.test(name);
}

/**
 * Validate a marker-bucket name that came from the watched repo's own `.chong/config.json`.
 *
 * Returns the (trimmed) name unchanged when it is a well-formed S3 bucket name. An empty
 * value (nothing configured, or blank after trim) is treated as "no bucket" silently — the
 * same state as omitting the key. Anything non-empty that fails the grammar is refused with a
 * one-line error naming the config key, the repo, and why (mirrors the voice/mechanism of
 * {@link rejectUnsafeConfiguredCmd}'s startup refusal), and reads as "no bucket configured"
 * rather than being used anyway.
 */
function validateMarkerBucketName(
  repoPath: string,
  key: "stageDeployedShaBucket" | "prodDeployedShaBucket",
  raw: string,
): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (isValidMarkerBucketName(name)) return name;
  console.error(
    c.red(
      `chong: refusing .chong/config.json "${key}" (${repoPath}) — "${name}" is not a valid S3 bucket name (must match ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$, must not contain ".." and must not look like an IP address). A committed repo config must not be able to redirect where deploy markers are written or read from. Treating this repo as though no ${key} were configured.`,
    ),
  );
  return null;
}

/**
 * The bucket to write the SHA marker to, or null when this repo has none.
 *
 * Config only — no sniffing. This used to fall back to a hardcoded LynxCraft
 * bucket for any repo containing scripts/deploy-frontend.sh, which meant chong
 * shipped one project's infrastructure name and would write that project's
 * marker on behalf of a repo that merely had a similarly-named script. The repo
 * declares its own bucket in .chong/config.json; a repo that declares none gets
 * no marker, which is the safe default. See {@link validateMarkerBucketName} for the
 * format check applied to whatever the repo configures.
 */
export function stageDeployedShaBucket(repoPath: string): string | null {
  const raw = loadRepoDeployConfig(repoPath).stageDeployedShaBucket;
  return raw ? validateMarkerBucketName(repoPath, "stageDeployedShaBucket", raw) : null;
}

/** Production marker bucket, or null when this repo has none configured (see {@link validateMarkerBucketName}). */
export function prodDeployedShaBucket(repoPath: string): string | null {
  const raw = loadRepoDeployConfig(repoPath).prodDeployedShaBucket;
  return raw ? validateMarkerBucketName(repoPath, "prodDeployedShaBucket", raw) : null;
}

/**
 * Shell metacharacters refused in a CONFIGURED deploy command.
 *
 * `.chong/config.json` is *deliberately committed* to each watched repo (chong's own
 * `.gitignore` rule is `.chong/*` + `!.chong/config.json` — see {@link ensureChongIgnored}).
 * Its `stageDeployCmd` / `prodDeployCmd` is executed via `bash -c` with the operator's full
 * environment, AWS credentials included. So anyone who can land a commit in a watched repo
 * — or any supply-chain compromise of it — would otherwise get arbitrary code execution on
 * the operator's laptop. This does not sanitize the string (there is no safe rewrite of
 * shell syntax we did not ask for); it refuses to run it at all.
 *
 * Deliberately narrow: only characters that let repo-supplied text escape "one command,
 * plain args" and reach the shell itself (command separators/substitution/redirection).
 * `=` and spaces are untouched — `defaultStageDeployCmd`'s own built-in
 * `"CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 ./scripts/deploy-frontend.sh ci"` must keep
 * working, and it is chong's own trusted string, not repo-supplied.
 */
const FORBIDDEN_CMD_CHARS = /[;|&$`()<>\n\r]/;

function describeForbiddenChar(ch: string): string {
  if (ch === "\n") return "\\n (newline)";
  if (ch === "\r") return "\\r (carriage return)";
  return `"${ch}"`;
}

/**
 * Validate a deploy command that came from the watched repo's own `.chong/config.json`.
 *
 * Returns the command unchanged when it is safe. When it contains a forbidden shell
 * metacharacter, refuses to run anything and returns null — the same "no deploy command"
 * state the caller is already in for a repo with none configured — rather than trying to
 * strip/escape and run a neutered version of what the config asked for. Also prints a
 * clear, actionable message so the refusal is not silent (this runs at `chong watch`
 * startup, before the TUI takes the alt screen, so it lands in normal scrollback).
 *
 * NOT applied to `packageJsonStageDeploy` / `packageJsonProdDeploy`: those return a fixed
 * `"npm run deploy:stage"` / `"npm run deploy:prod"` literal — chong's own string, gated
 * only by whether the script key exists, never repo-supplied text — so there is nothing
 * for a compromised repo to inject there. Also NOT applied in `resolveStageDeployCmd`'s
 * `configured` parameter: that value comes from the operator's own `--stage-deploy-cmd`
 * CLI flag (see `src/commands/watch.ts`), which the operator typed themselves — trusted,
 * not repo config.
 */
function rejectUnsafeConfiguredCmd(
  repoPath: string,
  key: "stageDeployCmd" | "prodDeployCmd",
  cmd: string,
): string | null {
  const match = cmd.match(FORBIDDEN_CMD_CHARS);
  if (!match) return cmd;
  const target = key === "stageDeployCmd" ? "stage" : "production";
  console.error(
    c.red(
      `chong: refusing .chong/config.json "${key}" (${repoPath}) — contains shell metacharacter ${describeForbiddenChar(match[0])}. A committed repo config must not be able to inject shell syntax into commands run with the operator's environment. Treating this repo as though no local ${target} deploy command were configured.`,
    ),
  );
  return null;
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
  if (configured) return rejectUnsafeConfiguredCmd(repoPath, "stageDeployCmd", configured);

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
  if (configured) return rejectUnsafeConfiguredCmd(repoPath, "prodDeployCmd", configured);

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

/**
 * Caller identity for the notify-discord relay. A literal, not the local
 * `repoPath` variable used elsewhere in this file: it names the repo that owns
 * this code, not the repo being deployed.
 */
const DISCORD_NOTIFY_REPO_PATH = "https://github.com/sesam/chong";

/**
 * Service token for the notify relay: `DISCORD_NOTIFY_TOKEN`, else `~/.chong/notify-token`.
 *
 * The file fallback is the one that matters. `chong watch` is a long-running daemon, so it
 * inherits the environment of whichever shell happened to start it — export the var today
 * and the watch you started yesterday still posts unauthenticated, which is exactly how
 * this was first noticed. A machine-local file survives restarts and needs no shell setup.
 * Outside any repo on purpose: the credential identifies chong itself, not the repo being
 * watched, and `<repo>/.chong/config.json` is a committed file.
 */
function discordNotifyToken(): string {
  const fromEnv = String(process.env.DISCORD_NOTIFY_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(path.join(homedir(), ".chong", "notify-token"), "utf8").trim();
  } catch {
    return "";
  }
}

export async function notifyDiscordStage(message: string): Promise<boolean> {
  const token = discordNotifyToken();
  // Strictly additive: with no token configured we send byte-for-byte the body
  // we always sent. Never `token: ""` — an empty credential is a failed auth,
  // not an absent one, and unauthenticated posts still deliver (they just page
  // the relay owner, which is the noise this is meant to stop).
  const payload = JSON.stringify(
    token
      ? {
          webhookUrl: DISCORD_CHANNEL,
          message,
          repoPath: DISCORD_NOTIFY_REPO_PATH,
          token,
        }
      : { webhookUrl: DISCORD_CHANNEL, message },
  );
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

  if (acquired.reason === "no-bucket") {
    // Not a write failure: acquireDeployClaim never got as far as writing anything. This
    // repo's .chong/config.json is missing the marker bucket key for this target — a config
    // gap, distinct from an S3 write failing.
    const key = target === "stage" ? "stageDeployedShaBucket" : "prodDeployedShaBucket";
    return {
      proceed: false,
      result: {
        action: "error",
        message: `no ${key} configured in .chong/config.json — cannot claim a ${target} deploy marker bucket`,
        sha,
      },
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

/** Grace period between SIGTERM and SIGKILL when an abort has to reach a process group. */
const ABORT_KILL_GRACE_MS = 5_000;

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
  //
  // `detached: true` makes this shell its own process group leader (POSIX `setsid`), so
  // an abort below can signal the whole tree instead of just `bash`. Without it, the real
  // uploaders — `s5cmd` / `aws s3 sync`, spawned as children of the shell — survive a kill
  // of the `bash` pid alone and keep writing to the deploy bucket after chong has already
  // reported the deploy aborted, sometimes interleaving with a deploy another watch starts
  // after taking over the claim.
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: shadowPath,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
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

  // Negative pid signals the whole process group `detached` created above, not just
  // `bash`. The group can already be gone by the time this fires (bash and its children
  // exited on their own between polls) — ESRCH there is expected, not a bug.
  const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      /* process group already gone */
    }
  };

  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const poll = setInterval(() => {
    if (aborted || !opts.shouldAbort?.()) return;
    aborted = true;
    killGroup("SIGTERM");
    // Escalate if the tree ignores SIGTERM (e.g. an uploader mid-syscall).
    killTimer = setTimeout(() => killGroup("SIGKILL"), ABORT_KILL_GRACE_MS);
  }, 2_000);

  // try/finally: if draining the streams ever rejects, the poll interval and a pending
  // SIGKILL timer must not leak for the life of the process — they are cleared whether the
  // drain succeeds or throws.
  //
  // Deliberately no bound on the drain itself: a daemonizing grandchild (calls setsid(),
  // escaping the process group `detached: true` created above) that keeps the inherited
  // stdout/stderr pipe open could in theory hang this await forever, past the `finally`
  // above and never reaching the caller's claim-release `finally`. A wall-clock cap on
  // `new Response(...).text()` would fix that but also silently truncate a normal, slow
  // deploy's real output — there is no way to tell the two apart from out here. Reaching
  // for one would need per-chunk read progress (a distinct, larger change) rather than a
  // single overall timeout, so this is left as a known gap rather than guessed at here.
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearInterval(poll);
    if (killTimer) clearTimeout(killTimer);
  }
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

/**
 * Bound on a single heartbeat attempt — comfortably shorter than both
 * {@link CLAIM_HEARTBEAT_MS} (so a timed-out attempt frees the in-flight guard before the
 * next tick is due) and {@link CLAIM_STALE_MS} (so a hang here is nowhere near enough to
 * make another watch consider the claim stale on its own).
 */
const HEARTBEAT_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Consecutive heartbeat failures (thrown errors or timeouts) before treating the claim as
 * lost. A single flaky round-trip — a transient network blip — must not abort a running
 * upload; a run of them means this watch genuinely cannot maintain the claim, and believing
 * it still holds one it cannot refresh is worse than giving it up.
 */
const HEARTBEAT_FAILURE_LIMIT = 3;

/**
 * Race `promise` against `ms`, rejecting on timeout. `Promise.race` attaches a reaction to
 * both promises up front, so if `promise` settles after the timeout already won, that later
 * settlement is still "handled" — it can never surface as an unhandled rejection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Heartbeat the S3 claim while an upload runs; invoke onLost if stolen.
 *
 * `opts.heartbeat` / `opts.intervalMs` exist only so tests can inject a slow fake and a
 * short interval without touching real S3 or waiting on the real {@link CLAIM_HEARTBEAT_MS}.
 *
 * Each attempt is bounded by `opts.timeoutMs` (default {@link HEARTBEAT_ATTEMPT_TIMEOUT_MS}):
 * `beat()` reaches `Bun.spawn(["aws", ...])` with no timeout of its own, and a stalled
 * `aws s3 cp` (a common S3 CLI failure mode) would otherwise leave the in-flight guard stuck
 * forever, skipping every later tick — worse than not having the guard at all. A throw from
 * `beat()` (e.g. `aws` missing from PATH) is caught here rather than left to escape `void
 * tick()` as an unhandled rejection, which previously took the whole `chong watch` process
 * down. Failures and timeouts are reported via `opts.onProgress` and counted; after
 * {@link HEARTBEAT_FAILURE_LIMIT} in a row the claim is treated as lost (same as an explicit
 * `beat() -> false`) rather than swallowed indefinitely — a `chong watch` that cannot refresh
 * its claim should stop believing it holds one.
 */
export function startClaimHeartbeat(
  bucket: string | null,
  claim: DeployClaim | null,
  onLost: () => void,
  opts: {
    heartbeat?: (bucket: string, claim: DeployClaim) => Promise<boolean>;
    intervalMs?: number;
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
  } = {},
): () => void {
  if (!bucket || !claim) return () => {};
  const beat = opts.heartbeat ?? heartbeatDeployClaim;
  const intervalMs = opts.intervalMs ?? CLAIM_HEARTBEAT_MS;
  const timeoutMs = opts.timeoutMs ?? HEARTBEAT_ATTEMPT_TIMEOUT_MS;
  const note = opts.onProgress ?? (() => {});
  let lost = false;
  // In-flight guard: a slow S3 round-trip must not let the next tick stack on top of it —
  // overlapping heartbeats can complete out of order and race the claim-release logic.
  let inFlight = false;
  let consecutiveFailures = 0;
  const tick = async () => {
    if (lost || inFlight) return;
    inFlight = true;
    try {
      const ok = await withTimeout(beat(bucket, claim), timeoutMs, "heartbeat timed out");
      consecutiveFailures = 0;
      if (!ok) {
        lost = true;
        onLost();
      }
    } catch (err) {
      consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      note(
        `deploy: heartbeat attempt failed (${consecutiveFailures}/${HEARTBEAT_FAILURE_LIMIT}) — ${msg.slice(0, 160)}`,
      );
      if (consecutiveFailures >= HEARTBEAT_FAILURE_LIMIT && !lost) {
        lost = true;
        note("deploy: heartbeat failed repeatedly — treating claim as lost");
        onLost();
      }
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
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
  processId: string,
): Promise<{ shadowPath?: string; error?: string }> {
  // `processId` is required: this resets the shared worktree, so it must hold the claim.
  // It used to be optional and pass `undefined` through, which silently skipped the claim
  // check entirely — the fourth such bypass, and the one that only surfaced once
  // `ensureShadow` made the claim mandatory rather than opt-in.
  const shadow = await ensureShadow(repoPath, sha, { processId });
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
  const stopHeartbeat = startClaimHeartbeat(
    markerBucket,
    heldClaim,
    () => {
      claimLost = true;
      // shouldAbort below is `claimLost && !force`, so with force set losing the claim
      // does not abort anything — say so, rather than telling the operator an upload is
      // aborting while it keeps running.
      note(
        force
          ? "deploy prod: lost soft claim mid-upload — continuing (forced)"
          : "deploy prod: lost soft claim mid-upload — aborting",
      );
    },
    { onProgress: note },
  );

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
  const stopHeartbeat = startClaimHeartbeat(
    markerBucket,
    heldClaim,
    () => {
      claimLost = true;
      // Unlike the prod path, stage has no `force` option — shouldAbort below is a plain
      // `claimLost`, so losing the claim always aborts here; the message stays accurate.
      note("deploy stage: lost soft claim mid-upload — aborting");
    },
    { onProgress: note },
  );

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
