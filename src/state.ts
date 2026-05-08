import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git } from "./git";

export type LocalCL = {
  id: string;
  title: string;
  repo: string;
  branch: string;
  /** Path relative to the main worktree root (e.g. ".chong/wt/019-add-rate-limiting"). */
  worktree: string;
  created_at: string;
};

export type LocalState = {
  cls: Record<string, LocalCL>;
};

async function statePath(): Promise<string> {
  const main = await git.mainWorktree();
  return join(main, ".chong", "state.json");
}

export async function readState(): Promise<LocalState> {
  const p = await statePath();
  if (!existsSync(p)) return { cls: {} };
  return JSON.parse(await Bun.file(p).text()) as LocalState;
}

export async function writeState(s: LocalState): Promise<void> {
  const p = await statePath();
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, JSON.stringify(s, null, 2));
}

export async function findCLByCwd(cwd: string): Promise<string | null> {
  const s = await readState();
  const main = await git.mainWorktree();
  const cwdAbs = resolve(cwd);
  for (const [id, entry] of Object.entries(s.cls)) {
    const wt = entry.worktree.startsWith("/")
      ? entry.worktree
      : resolve(join(main, entry.worktree));
    if (cwdAbs === wt || cwdAbs.startsWith(`${wt}/`)) return id;
  }
  return null;
}

export async function worktreeAbsPath(entry: LocalCL): Promise<string> {
  if (entry.worktree.startsWith("/")) return entry.worktree;
  const main = await git.mainWorktree();
  return resolve(join(main, entry.worktree));
}
