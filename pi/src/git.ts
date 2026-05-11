import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { reposDir, workDir } from "./config";

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
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

export function bareRepoPath(repo: string): string {
  return join(reposDir, `${repo}.git`);
}

export function workPath(repo: string): string {
  return join(workDir, repo);
}

export const git = {
  /** Create a bare repo + matching working clone. Idempotent. */
  async ensureRepo(repo: string): Promise<void> {
    const bare = bareRepoPath(repo);
    if (!existsSync(bare)) {
      mkdirSync(bare, { recursive: true });
      await run(["git", "init", "--bare", "--initial-branch=main", bare]);
      await run(["git", "config", "receive.denyDeletes", "false"], { cwd: bare });
      await run(["git", "config", "receive.denyNonFastForwards", "false"], { cwd: bare });
    }
    const work = workPath(repo);
    if (!existsSync(work)) {
      mkdirSync(workDir, { recursive: true });
      await run(["git", "clone", bare, work]);
      await run(["git", "config", "user.name", "chong-pi"], { cwd: work });
      await run(["git", "config", "user.email", "chong-pi@local"], { cwd: work });
      // Seed an empty initial commit so `main` exists on both bare and work.
      try {
        await run(["git", "commit", "--allow-empty", "-m", "init"], { cwd: work });
        await run(["git", "push", "origin", "main"], { cwd: work });
      } catch {
        // Repo already had commits (e.g., re-init scenario).
      }
    }
  },

  /** Squash-merge `branch` into main on the working clone, push back to bare. Returns the new main sha. */
  async squashMerge(
    repo: string,
    branch: string,
    opts: { title: string; author: string; email: string },
  ): Promise<string> {
    const work = workPath(repo);
    await run(["git", "fetch", "origin", "--prune"], { cwd: work });
    await run(["git", "checkout", "main"], { cwd: work });
    await run(["git", "reset", "--hard", "origin/main"], { cwd: work });
    await run(["git", "merge", "--squash", `origin/${branch}`], { cwd: work });
    await run(
      [
        "git",
        "commit",
        "-m",
        opts.title,
        "--author",
        `${opts.author} <${opts.email}>`,
      ],
      { cwd: work },
    );
    await run(["git", "push", "origin", "main"], { cwd: work });
    try {
      await run(["git", "push", "origin", "--delete", branch], { cwd: work });
    } catch {
      // Branch already gone — fine.
    }
    return await run(["git", "rev-parse", "HEAD"], { cwd: work });
  },

  async log(
    repo: string,
    opts: { limit?: number; author?: string } = {},
  ): Promise<
    Array<{ sha: string; author: string; email: string; date: string; subject: string }>
  > {
    const work = workPath(repo);
    const args = [
      "git",
      "log",
      `--max-count=${opts.limit ?? 50}`,
      "--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s",
    ];
    if (opts.author) args.push(`--author=${opts.author}`);
    args.push("main");
    const out = await run(args, { cwd: work });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return {
          sha: parts[0] ?? "",
          author: parts[1] ?? "",
          email: parts[2] ?? "",
          date: parts[3] ?? "",
          subject: parts[4] ?? "",
        };
      });
  },

  async show(
    repo: string,
    sha: string,
  ): Promise<{
    sha: string;
    author: string;
    email: string;
    date: string;
    message: string;
    diff: string;
  }> {
    const work = workPath(repo);
    const meta = await run(
      [
        "git",
        "show",
        "--no-patch",
        "--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%B",
        sha,
      ],
      { cwd: work },
    );
    const tabIdx: number[] = [];
    for (let i = 0; i < meta.length && tabIdx.length < 4; i++) {
      if (meta[i] === "\t") tabIdx.push(i);
    }
    const [a, b, c, d] = tabIdx;
    const shaOut = a !== undefined ? meta.slice(0, a) : "";
    const author = a !== undefined && b !== undefined ? meta.slice(a + 1, b) : "";
    const email = b !== undefined && c !== undefined ? meta.slice(b + 1, c) : "";
    const date = c !== undefined && d !== undefined ? meta.slice(c + 1, d) : "";
    const message = d !== undefined ? meta.slice(d + 1).trimEnd() : "";
    const diff = await run(["git", "show", "--format=", sha], { cwd: work });
    return { sha: shaOut, author, email, date, message, diff };
  },
};
