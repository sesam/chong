import { api, uploadStream } from "../api";
import { formatChangedSinceMain } from "../format";
import { git } from "../git";
import { findCLByCwd, readState, worktreeAbsPath, writeState } from "../state";
import { c } from "../util";

export async function cmdUpload(_argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const id = await findCLByCwd(cwd);
  if (!id) {
    console.error(
      c.red("✗ not inside a chong worktree (no matching CL in .chong/state.json)"),
    );
    process.exit(1);
  }

  const state = await readState();
  const entry = state.cls[id];
  const wtAbs = await worktreeAbsPath(entry);

  console.log(c.bold(`${id}  ${entry.title}  →  ${entry.repo}`));
  console.log("");

  // Format every changed file in this worktree using the bundled, non-
  // configurable Prettier. Auto-fix commits land here, in the dev's local
  // git log, before anything is pushed.
  console.log(c.cyan("  formatting…"));
  const { formatted } = await formatChangedSinceMain(wtAbs);
  if (formatted.length > 0) {
    for (const f of formatted) console.log(c.dim(`    fixed: ${f}`));
    await git.add(formatted, wtAbs);
    await git.commit("style: prettier auto-format [chong]", wtAbs);
    console.log(c.green(`  ✓ formatted ${formatted.length} file${formatted.length === 1 ? "" : "s"}`));
  } else {
    console.log(c.green("  ✓ already clean"));
  }

  // Push the branch first so chong-server can act on it.
  console.log(c.dim(`  pushing ${entry.branch}…`));
  await git.push("origin", entry.branch, wtAbs);
  const sha = await git.headSha(wtAbs);

  // Stream server-side pipeline output.
  for await (const ev of uploadStream(id, sha)) {
    if (ev.event === "step") {
      process.stdout.write(c.cyan(`  ${ev.data}\n`));
    } else if (ev.event === "log") {
      process.stdout.write(`${ev.data}\n`);
    } else if (ev.event === "error") {
      process.stdout.write(c.red(`  ✗ ${ev.data}\n`));
    } else if (ev.event === "done") {
      process.stdout.write(c.green(`  ✓ ${ev.data}\n`));
    } else if (ev.event === "message" && ev.data) {
      process.stdout.write(`${ev.data}\n`);
    }
  }

  const final = await api.getCL(id);
  console.log("");

  if (final.status !== "LIVE") {
    console.log(c.red(`✗ ${id}  ${final.status}`));
    console.log(c.dim("  branch left in place — fix and re-run `chong upload`"));
    process.exit(1);
  }

  // Worktree cleanup must run from outside the worktree.
  const main = await git.mainWorktree();
  process.chdir(main);
  try {
    await git.worktreeRemove(wtAbs);
  } catch (e) {
    console.warn(c.yellow(`  (worktree remove warning: ${(e as Error).message})`));
  }
  await git.branchDelete(entry.branch);

  delete state.cls[id];
  await writeState(state);

  console.log(c.green(`✓ ${id} live`));
  if (final.sha) console.log(c.dim(`  ${final.sha.slice(0, 7)}`));
}
