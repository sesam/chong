import { c, parseArgs } from "../util";
import { runWatch } from "../watch/app";
import type { WatchConfig } from "../watch/model";
import { repo } from "../watch/repo";

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

  const cfg: WatchConfig = { repoPath, remote, branches, formatCmd, testCmd, i18nCmd };
  try {
    await runWatch(cfg, intervalMs);
  } finally {
    // ensure terminal is sane even if the loop threw mid-frame
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  process.stdout.write(c.dim("watch stopped.\n"));
}
