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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureShadow, runEslintFix, tryAgentLintFix } from "./checks";
import { formatLintSummary, isAgentableLintFailure, lintableChangedFiles, runEslint } from "./lint";
import { repo } from "./repo";

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

export function defaultStageDeployCmd(repoPath: string): string | null {
  if (!hasFrontendStageDeployScript(repoPath)) return null;
  // Prefer aws CLI — s5cmd is often missing on laptops; FORCE skips the tty prompt.
  return "FORCE=1 DEPLOY_S3_TOOL=aws ./scripts/deploy-frontend.sh ci";
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

/** Upload the SHA marker so GitHub stage CI can skip when already live. */
export async function writeS3DeployedSha(sha: string): Promise<string | null> {
  const uri = `s3://${STAGE_CI_BUCKET}/${DEPLOYED_SHA_KEY}`;
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

export async function readS3DeployedSha(): Promise<string | null> {
  const uri = `s3://${STAGE_CI_BUCKET}/${DEPLOYED_SHA_KEY}`;
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
  const s3Sha = fileSha ? null : await readS3DeployedSha();
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
  const proc = Bun.spawn(["bash", "-lc", cmd], {
    cwd: shadowPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FORCE: "1",
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
 * Lint (CI parity) then build+upload to the CI bucket from origin/main tip.
 * Does not push the `stage` git branch.
 */
export async function runLocalStageDeploy(
  repoPath: string,
  remote: string,
  mainBranch: string,
  stageBranch: string,
  deployCmd: string,
  opts: { agent?: boolean; onProgress?: (msg: string) => void } = {},
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

  const s3Err = await writeS3DeployedSha(tip);
  if (s3Err) {
    note(`deploy stage: live, but S3 marker failed (${s3Err.slice(0, 120)})`);
  }

  const subject = (await repo.commitMeta(repoPath, tip))?.subject ?? "";
  const discordOk = await notifyDiscordStage(
    `✅ FE stage (chong local): deployed ${tip.slice(0, 7)} ${subject}\nhttps://app-ci.lynx-craft.com`,
  );
  if (!discordOk) note("deploy stage: Discord notify failed");

  return {
    action: "deployed",
    message: `deployed ${tip.slice(0, 7)} → app-ci (local ${stageBranch} advanced, not pushed)`,
    sha: tip,
  };
}
