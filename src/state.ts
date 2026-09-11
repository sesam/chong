import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
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

/**
 * Persist local CL state. As in `src/config.ts`'s `writeAuth`, `Bun.write` leaves the file
 * at the umask default (commonly 0644, world-readable) with no mode of its own, so the
 * containing `.chong/` dir and this file are locked down the same way: dir 0700, file
 * 0600, applied even when either already existed with looser permissions. Best-effort —
 * a chmod failure is reported, not fatal.
 */
export async function writeState(s: LocalState): Promise<void> {
  const p = await statePath();
  const dir = dirname(p);
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o700);
  } catch (e) {
    console.error(`chong: could not chmod ${dir} to 0700 (${e instanceof Error ? e.message : e})`);
  }
  await Bun.write(p, JSON.stringify(s, null, 2));
  try {
    await chmod(p, 0o600);
  } catch (e) {
    console.error(`chong: could not chmod ${p} to 0600 (${e instanceof Error ? e.message : e})`);
  }
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
