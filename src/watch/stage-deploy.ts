/**
 * Local stage (app-ci) deploy for `chong watch`.
 *
 * Replaces git-pushing `main → stage` (which burned GitHub Actions minutes) with:
 *   1. a debounce countdown after origin/main moves
 *   2. `scripts/deploy-frontend.sh ci` from main-shadow at that tip
 *   3. advancing the **local** `stage` branch to that tip (tracking only — never pushed)
 *   4. an S3 marker (`deployed-git-sha.txt`) so a stray stage-branch CI run can no-op
 *   5. Discord via the notify-discord relay (same channel as FE CI)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureShadow, runEslintFix, tryAgentLintFix } from "./checks";
import { formatLintSummary, isAgentableLintFailure, lintableChangedFiles, runEslint } from "./lint";
import { repo } from "./repo";
import { formatUnresolvedSummary, scanUnresolvedImports } from "./unresolved-imports";

export const STAGE_CI_BUCKET = "lynx-ci-edge-20251117-4-static-files";
export const DEPLOYED_SHA_KEY = "deployed-git-sha.txt";
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
  action: "noop" | "deployed" | "fixed" | "blocked" | "error";
  message: string;
  sha?: string;
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
 * `STAGE_CI_BUCKET` was a hardcoded LynxCraft-FRONTEND bucket and the SHA marker was
 * written unconditionally on every successful deploy — so pointing `chong watch` at a
 * second repo would overwrite FRONTEND's `deployed-git-sha.txt` with the other repo's SHA,
 * and FRONTEND's stage CI (which reads that marker to decide whether it can no-op) would
 * skip a deploy it should have run. The marker is now opt-in per repo.
 */
export type RepoDeployConfig = {
  /** Deploy command; overrides detection. */
  stageDeployCmd?: string;
  /** S3 bucket for the deployed-SHA marker. Omit to skip the marker entirely. */
  stageDeployedShaBucket?: string;
};

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

/** The bucket to write the SHA marker to, or null when this repo has none. */
export function stageDeployedShaBucket(repoPath: string): string | null {
  const configured = loadRepoDeployConfig(repoPath).stageDeployedShaBucket?.trim();
  if (configured) return configured;
  // Legacy: LynxCraft FRONTEND predates the config file and its CI depends on the marker.
  return hasFrontendStageDeployScript(repoPath) ? STAGE_CI_BUCKET : null;
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
    // Prefer aws CLI — s5cmd is often missing on laptops; FORCE skips the tty prompt.
    // CI=true makes pnpm non-interactive (confirmModulesPurge). DEPLOY_SKIP_INSTALL=1
    // relies on the main-shadow node_modules symlink — no reinstall in the worktree.
    return "CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 DEPLOY_S3_TOOL=aws ./scripts/deploy-frontend.sh ci";
  }

  return packageJsonStageDeploy(repoPath);
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
      .some((l) => l === ".chong" || l === ".chong/" || l === "/.chong" || l === "/.chong/");
    if (covered) return;
    const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
    // `.chong/` holds two different kinds of thing, so the rule cannot be a blanket
    // ignore: state.json, stage-deployed-sha and wt/ are machine-local and must never be
    // committed, but config.json is deliberate per-repo configuration — which repo, which
    // deploy command, which marker bucket — and ignoring it would mean every clone and
    // every teammate silently loses it. The negation keeps state out and config in.
    appendFileSync(
      gitignore,
      `${prefix}\n# chong: machine-local state ignored, per-repo config committed\n.chong/\n!.chong/config.json\n`,
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
  const header =
    "✅ FE stage (chong local): Deployment completed successfully! Commits in this push:";

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

/** Upload the SHA marker so GitHub stage CI can skip when already live. */
export async function writeS3DeployedSha(bucket: string, sha: string): Promise<string | null> {
  const uri = `s3://${bucket}/${DEPLOYED_SHA_KEY}`;
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
      "text/plain",
      "--quiet",
    ],
    {
      stdin: new Blob([`${sha}\n`]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AWS_PAGER: "" },
    },
  );
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return code === 0 ? null : err.trim() || `aws s3 cp failed (${code})`;
}

export async function readS3DeployedSha(bucket: string): Promise<string | null> {
  const uri = `s3://${bucket}/${DEPLOYED_SHA_KEY}`;
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
 * Best-known live stage SHA, in order:
 *   1. local `stage` branch (primary deploy tracker)
 *   2. `.chong/stage-deployed-sha` backup file
 *   3. S3 `deployed-git-sha.txt`
 *
 * When the winner isn't already on local `stage`, the ref is advanced to match
 * (so the pipeline lane stays consistent across restarts).
 */
export async function resolveDeployedStageSha(
  repoPath: string,
  stageBranch = STAGE_TRACK_BRANCH,
): Promise<string | null> {
  const branchSha = await repo.localSha(repoPath, stageBranch);
  if (branchSha) {
    writeLocalDeployedSha(repoPath, branchSha);
    return branchSha.toLowerCase();
  }

  const fileSha = readLocalDeployedSha(repoPath);
  // No bucket configured for this repo means no marker to read — see
  // stageDeployedShaBucket. The local ref and the .chong backup still apply.
  const markerBucket = stageDeployedShaBucket(repoPath);
  const s3Sha = fileSha || !markerBucket ? null : await readS3DeployedSha(markerBucket);
  const recovered = fileSha ?? s3Sha;
  if (!recovered) return null;

  const err = await markLocalStageDeployed(repoPath, recovered, stageBranch);
  if (err) {
    // Still usable as a tip even if we couldn't create the branch (e.g. checked out).
    writeLocalDeployedSha(repoPath, recovered);
  }
  return recovered;
}

async function runDeployCommand(
  shadowPath: string,
  cmd: string,
): Promise<{ ok: boolean; output: string }> {
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
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const output = `${stdout}\n${stderr}`.trim();
  return { ok: code === 0, output };
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

/**
 * Lint (CI parity) then build+upload to the CI bucket from origin/main tip.
 * Does not push the `stage` git branch.
 */
export async function runLocalStageDeploy(
  repoPath: string,
  remote: string,
  mainBranch: string,
  stageBranch: string,
  deployCmd: string,
  opts: { agent?: boolean; importScan?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<StageDeployResult> {
  const tip = await repo.tip(repoPath, remote, mainBranch);
  if (!tip) return { action: "error", message: `could not resolve ${remote}/${mainBranch}` };

  const already =
    (await repo.localSha(repoPath, stageBranch))?.toLowerCase() ?? readLocalDeployedSha(repoPath);
  if (already && already === tip.toLowerCase()) {
    return { action: "noop", message: `stage already at ${tip.slice(0, 7)}`, sha: tip };
  }

  const note = opts.onProgress ?? (() => {});
  note(`deploy stage: resetting shadow to ${tip.slice(0, 7)}…`);

  const shadow = await ensureShadow(repoPath, tip);
  if (shadow.error) {
    return { action: "blocked", message: `shadow: ${shadow.error}`, sha: tip };
  }

  note("deploy stage: eslint gate…");
  const gate = await eslintGate(
    repoPath,
    shadow.shadowPath,
    remote,
    mainBranch,
    stageBranch,
    already,
    tip,
    opts.agent !== false,
  );
  if (gate) return gate;

  if (opts.importScan !== false) {
    note("deploy stage: unresolved-import scan…");
    const importGate = await unresolvedImportGate(shadow.shadowPath, tip);
    if (importGate) return importGate;
  }

  // Copy repo .env into shadow so Vite sees the same secrets as a manual local deploy.
  const envSrc = path.join(repoPath, ".env");
  const envDst = path.join(shadow.shadowPath, ".env");
  if (existsSync(envSrc)) {
    try {
      await Bun.write(envDst, await Bun.file(envSrc).arrayBuffer());
    } catch {
      /* deploy script will warn */
    }
  }

  note(`deploy stage: running ${deployCmd}…`);
  const run = await runDeployCommand(shadow.shadowPath, deployCmd);
  if (!run.ok) {
    const tail = run.output.slice(-1500);
    await notifyDiscordStage(
      `🚨 FE stage (chong local): deploy failed at ${tip.slice(0, 7)}\n\`\`\`\n${tail}\n\`\`\``,
    );
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

  // Only when this repo owns a marker bucket — see stageDeployedShaBucket.
  const markerBucket = stageDeployedShaBucket(repoPath);
  if (markerBucket) {
    const s3Err = await writeS3DeployedSha(markerBucket, tip);
    if (s3Err) {
      note(`deploy stage: live, but S3 marker failed (${s3Err.slice(0, 120)})`);
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
}
