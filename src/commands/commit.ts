import path from "node:path";
import { c } from "../util";
import { repo } from "../watch/repo";
import { detectRepoProfile } from "../watch/repo-profile";
import { anyFailed, runChecks } from "../watch/run-checks";
import { printResults } from "./verify";

const USAGE =
  'usage: chong commit -m "<msg>" [<path>...] [--rm <a,b,...>] [--patch <file>] [--no-verify]';

/**
 * Atomic commit that bypasses the shared git index. Safe to run while parallel
 * agents stage/commit in the same worktree — see repo.commit().
 *
 *   chong commit -m "msg" src/a.ts src/b.ts   # commit working-tree state of these paths
 *   chong commit -m "msg" --rm old.ts,dead.ts # commit deletions
 *   chong commit -m "msg" --patch hunks.diff  # commit specific hunks (vs HEAD)
 */
export async function cmdCommit(argv: string[]): Promise<void> {
  let message: string | undefined;
  let removeCsv: string | undefined;
  let patchFile: string | undefined;
  const add: string[] = [];
  let noVerify = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m" || a === "--message") message = argv[++i];
    else if (a === "--rm") removeCsv = argv[++i];
    else if (a === "--patch") patchFile = argv[++i];
    else if (a === "--no-verify") noVerify = true;
    else if (a.startsWith("-")) {
      console.error(c.red(`unknown flag: ${a}`));
      console.error(c.dim(USAGE));
      process.exit(1);
    } else add.push(a);
  }

  if (!message) {
    console.error(c.red(USAGE));
    process.exit(1);
  }

  const remove = removeCsv
    ? removeCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (!noVerify && add.length > 0) {
    // Commit-phase checks on just the paths being committed. No applicable checks = no-op.
    const cwd = process.cwd();
    const top = (await repo.isGitRepo(cwd)) ? await repo.topLevel(cwd) : cwd;
    const rel = add.map((p) => path.relative(top, path.resolve(cwd, p)));
    const results = await runChecks(top, detectRepoProfile(top).checks, {
      files: rel,
      phase: "commit",
    });
    if (anyFailed(results)) {
      printResults(results);
      console.error(c.red("✗ checks failed — nothing committed."));
      console.error(c.dim("  fix: chong verify --fix   ·   bypass: chong commit --no-verify"));
      process.exit(1);
    }
  }

  const res = await repo.commit(process.cwd(), { message, add, remove, patchFile });
  if (res.error || !res.sha) {
    console.error(c.red(`✗ ${res.error ?? "commit failed"}`));
    process.exit(1);
  }
  console.log(c.green(`✓ ${res.sha.slice(0, 7)}`) + c.dim(`  ${message.split("\n")[0]}`));
}
