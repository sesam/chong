async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${code}\n${err.trim()}`);
  }
  return out.trim();
}

export type Worktree = { path: string; branch: string };

export const git = {
  fetch: (remote = "origin") => run(["git", "fetch", remote]),

  currentBranch: (cwd?: string) =>
    run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd }),

  topLevel: (cwd?: string) =>
    run(["git", "rev-parse", "--show-toplevel"], { cwd }),

  remoteUrl: (remote = "origin") =>
    run(["git", "remote", "get-url", remote]),

  push: (remote: string, branch: string, cwd?: string) =>
    run(["git", "push", "--set-upstream", remote, branch], { cwd }),

  mergeBase: (a: string, b: string, cwd?: string) =>
    run(["git", "merge-base", a, b], { cwd }),

  /** Files changed (added/modified/renamed) between `base` and HEAD. Excludes deletions. */
  diffNames: async (base: string, cwd?: string): Promise<string[]> => {
    const out = await run(
      ["git", "diff", "--name-only", "--diff-filter=ACMR", base, "HEAD"],
      { cwd },
    );
    return out.split("\n").filter(Boolean);
  },

  /** Files changed in the working tree (relative to HEAD), staged or unstaged. */
  workingChanges: async (cwd?: string): Promise<string[]> => {
    const out = await run(["git", "status", "--porcelain"], { cwd });
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
  },

  add: (paths: string[], cwd?: string) =>
    run(["git", "add", "--", ...paths], { cwd }),

  commit: (message: string, cwd?: string) =>
    run(["git", "commit", "-m", message], { cwd }),

  worktreeAdd: (path: string, branch: string, base: string) =>
    run(["git", "worktree", "add", "-b", branch, path, base]),

  worktreeRemove: (path: string) =>
    run(["git", "worktree", "remove", "--force", path]),

  branchDelete: async (branch: string): Promise<void> => {
    try {
      await run(["git", "branch", "-D", branch]);
    } catch {
      // already gone — fine
    }
  },

  listWorktrees: async (): Promise<Worktree[]> => {
    const out = await run(["git", "worktree", "list", "--porcelain"]);
    const blocks = out.split(/\n\n+/).filter(Boolean);
    return blocks.map((b) => {
      const lines = b.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
      const branchLine = lines.find((l) => l.startsWith("branch "));
      const branch = branchLine?.slice(7).replace(/^refs\/heads\//, "") ?? "";
      return { path, branch };
    });
  },

  /** Path to the main worktree (the one that owns .git/). */
  mainWorktree: async (): Promise<string> => {
    const list = await git.listWorktrees();
    if (list.length > 0) return list[0].path;
    return git.topLevel();
  },
};
