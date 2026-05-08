import { api } from "../api";
import { git } from "../git";
import { findCLByCwd, readState, worktreeAbsPath, writeState } from "../state";
import { c, parseArgs } from "../util";

export async function cmdAbandon(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  let id = positional[0];
  if (!id) {
    const found = await findCLByCwd(process.cwd());
    if (!found) {
      console.error(c.red("usage: chong abandon <id>   (or run from inside a worktree)"));
      process.exit(1);
    }
    id = found;
  }

  const state = await readState();
  const entry = state.cls[id];

  try {
    await api.abandonCL(id);
  } catch (e) {
    console.warn(c.yellow(`  (server abandon failed: ${(e as Error).message})`));
  }

  if (entry) {
    const main = await git.mainWorktree();
    process.chdir(main);
    const wtAbs = await worktreeAbsPath(entry);
    try {
      await git.worktreeRemove(wtAbs);
    } catch {
      // worktree already gone
    }
    await git.branchDelete(entry.branch);
    delete state.cls[id];
    await writeState(state);
  }

  console.log(c.yellow(`abandoned ${id}`));
}
