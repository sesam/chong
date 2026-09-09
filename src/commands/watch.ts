import { c, parseArgs } from "../util";
import { runWatch } from "../watch/app";
import type { WatchConfig } from "../watch/model";
import { repo } from "../watch/repo";
import {
  DEFAULT_DEPLOY_COOLDOWN_SEC,
  ensureChongIgnored,
  hasFrontendStageDeployScript,
} from "../watch/stage-deploy";

const DEFAULT_BRANCHES = ["main", "stage", "prod"];
const DEFAULT_INTERVAL_S = 15;

export async function cmdWatch(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);

  const path = positional[0] ?? process.cwd();
  if (!(await repo.isGitRepo(path))) {
    throw new Error(`${path} is not a git repository`);
  }
  const repoPath = await repo.topLevel(path);

  const remote = typeof flags.remote === "string" ? flags.remote : "origin";
  const branches =
    typeof flags.branches === "string"
      ? flags.branches
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean)
      : DEFAULT_BRANCHES;
  const interval = typeof flags.interval === "string" ? Number(flags.interval) : DEFAULT_INTERVAL_S;
  const intervalMs = Math.max(3, Number.isFinite(interval) ? interval : DEFAULT_INTERVAL_S) * 1000;

  if (branches.length < 2) {
    throw new Error("need at least 2 branches to form a pipeline (e.g. --branches main,prod)");
  }

  const formatCmd = typeof flags["format-cmd"] === "string" ? flags["format-cmd"] : "pnpm format";
  const testCmd = typeof flags["test-cmd"] === "string" ? flags["test-cmd"] : "pnpm test";
  const i18nCmd = typeof flags["i18n-cmd"] === "string" ? flags["i18n-cmd"] : "pnpm i18n";
  const i18nScan = flags["no-i18n-scan"] !== true;
  const agent = flags["no-agent"] !== true;
  const importScan = flags["no-import-scan"] !== true;
  const autoMaintain = flags["no-auto-maintain"] !== true;

  // Local stage deploy (default on for FRONTEND). Legacy --no-auto-promote-stage still disables it.
  const autoDeployStage =
    flags["no-auto-deploy-stage"] !== true && flags["no-auto-promote-stage"] !== true;
  const cooldownRaw =
    typeof flags["deploy-cooldown"] === "string" ? Number(flags["deploy-cooldown"]) : Number.NaN;
  const deployCooldownSec =
    Number.isFinite(cooldownRaw) && cooldownRaw >= 0
      ? Math.floor(cooldownRaw)
      : DEFAULT_DEPLOY_COOLDOWN_SEC;
  const stageDeployCmd =
    typeof flags["stage-deploy-cmd"] === "string" ? flags["stage-deploy-cmd"] : "";

  // Soft default: only auto-arm when the FE deploy script exists unless the user
  // forced a command. Avoid surprising non-FRONTEND repos.
  //
  // Deliberately NOT widened to "any repo with a deploy:stage script", even though
  // defaultStageDeployCmd now detects one. Detection is for the manual `[s]` key; arming
  // an unattended deploy off it would be dangerous for a serverless backend, where the
  // deploy tool commonly defaults absent env vars to the empty string. If the secrets live
  // in CI and the watcher does not hold them, an automatic deploy can quietly replace live
  // configuration with blanks — and the deploy still reports success. A deploy that needs
  // credentials the watcher does not have must be a deliberate keypress, not a 60s
  // cooldown. Opt in per repo via `stageDeployCmd` in `.chong/config.json`, or
  // `--stage-deploy-cmd`.
  const effectiveAutoDeploy =
    autoDeployStage && (stageDeployCmd.trim() !== "" || hasFrontendStageDeployScript(repoPath));

  // chong keeps per-repo state in <repo>/.chong — create it and make sure git ignores it
  // before anything writes there, so it can never be swept into someone else's commit in
  // a shared working tree.
  ensureChongIgnored(repoPath);

  const cfg: WatchConfig = {
    repoPath,
    remote,
    branches,
    formatCmd,
    testCmd,
    i18nCmd,
    i18nScan,
    agent,
    autoMaintain,
    autoDeployStage: effectiveAutoDeploy,
    deployCooldownSec,
    stageDeployCmd,
    importScan,
    stageDeployedSha: null,
  };
  try {
    await runWatch(cfg, intervalMs);
  } finally {
    // ensure terminal is sane even if the loop threw mid-frame
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  process.stdout.write(c.dim("watch stopped.\n"));
}
