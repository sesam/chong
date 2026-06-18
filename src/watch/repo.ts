import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Commit } from "./types";

type Run = { ok: boolean; out: string; err: string; code: number };

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim(), code };
}

/** Files touched by a patch, parsed from `git apply --numstat` (last tab field). */
async function pathsInPatch(cwd: string, patchFile?: string): Promise<string[]> {
  if (!patchFile) return [];
  const r = await git(["apply", "--numstat", "--", patchFile], cwd);
  if (!r.ok || !r.out) return [];
  return r.out
    .split("\n")
    .map((line) => line.split("\t").pop()?.trim() ?? "")
    .filter(Boolean);
}

export type CommitInput = {
  message: string;
  /** Paths whose current working-tree content should be committed (new or modified). */
  add?: string[];
  /** Paths to delete (committed as removals regardless of working-tree state). */
  remove?: string[];
  /** A unified-diff file applied with `git apply --cached` for hunk-level commits. */
  patchFile?: string;
};

export type CommitResult = { sha: string | null; error: string | null };

const SEP = "\x1f"; // unit separator — safe field delimiter inside commit metadata
const FORMAT = ["%H", "%an", "%ar", "%aI", "%s"].join(SEP);

function parseCommit(line: string): Commit | null {
  const [sha, author, rel, iso, ...subjectParts] = line.split(SEP);
  if (!sha) return null;
  return {
    sha,
    short: sha.slice(0, 7),
    author: author ?? "",
    rel: shortRel(rel ?? ""),
    iso: iso ?? "",
    subject: subjectParts.join(SEP),
  };
}

/** "2 minutes ago" → "2m", "3 hours ago" → "3h", "5 days ago" → "5d". */
function shortRel(s: string): string {
  const m = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/);
  if (!m) return s.replace(" ago", "");
  const n = m[1];
  const unit = m[2][0] === "m" && m[2].startsWith("mo") ? "mo" : m[2][0];
  return `${n}${unit}`;
}

export const repo = {
  async isGitRepo(cwd: string): Promise<boolean> {
    return (await git(["rev-parse", "--git-dir"], cwd)).ok;
  },

  async topLevel(cwd: string): Promise<string> {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).out;
  },

  async remoteUrl(cwd: string, remote: string): Promise<string | null> {
    const r = await git(["remote", "get-url", remote], cwd);
    return r.ok ? r.out : null;
  },

  /** Fetch the given branches; returns an error message on failure, else null. */
  async fetch(cwd: string, remote: string, branches: string[]): Promise<string | null> {
    const r = await git(["fetch", "--quiet", remote, ...branches], cwd);
    return r.ok ? null : r.err || `git fetch ${remote} failed`;
  },

  /** Which of the requested branches exist on the remote. */
  async existingRemoteBranches(cwd: string, remote: string, branches: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const b of branches) {
      const r = await git(["rev-parse", "--verify", "--quiet", `${remote}/${b}`], cwd);
      if (r.ok) found.push(b);
    }
    return found;
  },

  async tip(cwd: string, remote: string, branch: string): Promise<string> {
    return (await git(["rev-parse", `${remote}/${branch}`], cwd)).out;
  },

  async commitMeta(cwd: string, ref: string): Promise<Commit | null> {
    const r = await git(["log", "-1", `--format=${FORMAT}`, ref], cwd);
    return r.ok ? parseCommit(r.out) : null;
  },

  /**
   * Commits reachable from `from` but not `to` (i.e. queued to promote from → to),
   * newest first.
   */
  async logBetween(
    cwd: string,
    remote: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<Commit[]> {
    const range = `${remote}/${to}..${remote}/${from}`;
    const r = await git(["log", `--format=${FORMAT}`, `-n${limit}`, range], cwd);
    if (!r.ok || !r.out) return [];
    return r.out
      .split("\n")
      .map(parseCommit)
      .filter((x): x is Commit => x !== null);
  },

  /** Recent commits on a single branch, newest first. */
  async recentLog(cwd: string, remote: string, branch: string, limit: number): Promise<Commit[]> {
    const r = await git(["log", `--format=${FORMAT}`, `-n${limit}`, `${remote}/${branch}`], cwd);
    if (!r.ok || !r.out) return [];
    return r.out
      .split("\n")
      .map(parseCommit)
      .filter((x): x is Commit => x !== null);
  },

  async currentBranch(cwd: string): Promise<string> {
    const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return r.ok && r.out ? r.out : "HEAD";
  },

  /** Recent commits on a local branch (no remote prefix), newest first. */
  async localRecentLog(cwd: string, branch: string, limit: number): Promise<Commit[]> {
    const r = await git(["log", `--format=${FORMAT}`, `-n${limit}`, branch], cwd);
    if (!r.ok || !r.out) return [];
    return r.out
      .split("\n")
      .map(parseCommit)
      .filter((x): x is Commit => x !== null);
  },

  /** { ahead: commits on `from` not `to`, behind: commits on `to` not `from` }. */
  async aheadBehind(
    cwd: string,
    remote: string,
    from: string,
    to: string,
  ): Promise<{ ahead: number; behind: number }> {
    // `--left-right --count A...B` → "<left=A-only>\t<right=B-only>"
    const r = await git(
      ["rev-list", "--left-right", "--count", `${remote}/${to}...${remote}/${from}`],
      cwd,
    );
    if (!r.ok) return { ahead: 0, behind: 0 };
    const [left, right] = r.out.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    return { behind: left, ahead: right };
  },

  /** True if promoting from → to is a clean fast-forward (to is an ancestor of from). */
  async isFastForward(cwd: string, remote: string, from: string, to: string): Promise<boolean> {
    const r = await git(
      ["merge-base", "--is-ancestor", `${remote}/${to}`, `${remote}/${from}`],
      cwd,
    );
    return r.ok;
  },

  /**
   * Fast-forward the remote `to` branch up to the current tip of `from`, without
   * touching the local working tree. Pushes the resolved sha directly to the ref.
   */
  async pushFastForward(
    cwd: string,
    remote: string,
    from: string,
    to: string,
  ): Promise<string | null> {
    const sha = await repo.tip(cwd, remote, from);
    if (!sha) return `could not resolve ${remote}/${from}`;
    const r = await git(["push", remote, `${sha}:refs/heads/${to}`], cwd);
    return r.ok ? null : r.err || "push failed";
  },

  /** Sha of a local branch, or null if the branch doesn't exist locally. */
  async localSha(cwd: string, branch: string): Promise<string | null> {
    const r = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    return r.ok && r.out ? r.out : null;
  },

  /** True if `a` is an ancestor of `b` — i.e. b can be reached from a by fast-forward. */
  async isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
    return (await git(["merge-base", "--is-ancestor", a, b], cwd)).ok;
  },

  /** Count of commits reachable from `to` but not `from` (how far `from` is behind `to`). */
  async behindCount(cwd: string, from: string, to: string): Promise<number> {
    const r = await git(["rev-list", "--count", `${from}..${to}`], cwd);
    return r.ok ? Number.parseInt(r.out, 10) || 0 : 0;
  },

  /**
   * The worktree path where `branch` is currently checked out, or null if it isn't
   * checked out in any worktree. Used to decide whether a local ref can be moved
   * directly (safe) or must go through a fast-forward merge in its worktree.
   */
  async worktreeFor(cwd: string, branch: string): Promise<string | null> {
    const r = await git(["worktree", "list", "--porcelain"], cwd);
    if (!r.ok) return null;
    let path: string | null = null;
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) {
        const name = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        if (name === branch) return path;
      }
    }
    return null;
  },

  /**
   * Move a local branch ref to `newSha`, but only if it still points at `oldSha`
   * (guards against a concurrent update). Caller must have verified this is a
   * fast-forward; never call for a branch checked out in a worktree.
   */
  async updateLocalRef(
    cwd: string,
    branch: string,
    newSha: string,
    oldSha: string,
  ): Promise<string | null> {
    const r = await git(["update-ref", `refs/heads/${branch}`, newSha, oldSha], cwd);
    return r.ok ? null : r.err || "update-ref failed";
  },

  /**
   * Fast-forward the branch checked out in `worktree` up to `remote/branch`.
   * `--ff-only` makes git refuse anything but a clean fast-forward, and git aborts
   * (leaving the tree untouched) if local changes to the incoming files would be
   * overwritten — so a dirty worktree is only advanced when it's safe to do so.
   * Returns null on success, else a short reason.
   */
  async mergeFastForward(worktree: string, remote: string, branch: string): Promise<string | null> {
    const r = await git(["merge", "--ff-only", `${remote}/${branch}`], worktree);
    if (r.ok) return null;
    // Collapse git's multi-line "local changes would be overwritten" into one line.
    const msg = (r.err || r.out).split("\n").find(Boolean) ?? "fast-forward merge failed";
    return msg;
  },

  /**
   * Build and land a commit WITHOUT touching the worktree's shared index (`.git/index`).
   *
   * The whole commit is assembled in a throwaway private index (`GIT_INDEX_FILE`) seeded
   * from HEAD, turned into a tree with `write-tree`, sealed with `commit-tree`, then landed
   * with a compare-and-swap `update-ref <new> <old>`. Because the shared index is never read
   * or written, a parallel agent's `git add`/`commit`/`reset` in the same worktree can neither
   * leak into this commit nor be swept up by it. If HEAD moves between read and ref update,
   * the CAS fails and we rebuild onto the new tip (up to a few attempts).
   *
   * Afterwards we resync ONLY the committed paths in the shared index (`git reset -- <paths>`)
   * so `git status` is clean for them while leaving any unrelated staged work intact.
   */
  async commit(cwd: string, input: CommitInput): Promise<CommitResult> {
    const add = input.add ?? [];
    const remove = input.remove ?? [];
    const msg = input.message;
    if (!msg.trim()) return { sha: null, error: "empty commit message" };
    if (add.length === 0 && remove.length === 0 && !input.patchFile) {
      return { sha: null, error: "nothing to commit (pass paths, --rm, or --patch)" };
    }

    // The ref HEAD points at (a branch), or "HEAD" itself when detached.
    const sym = await git(["symbolic-ref", "--quiet", "HEAD"], cwd);
    const ref = sym.ok && sym.out ? sym.out : "HEAD";

    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await git(["rev-parse", "HEAD"], cwd);
      if (!head.ok || !head.out) return { sha: null, error: head.err || "could not resolve HEAD" };
      const old = head.out;

      const idx = join(tmpdir(), `chong-index-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: idx };
      try {
        // Seed the PRIVATE index from HEAD — the shared .git/index is left untouched.
        const seed = await git(["read-tree", old], cwd, env);
        if (!seed.ok) return { sha: null, error: seed.err || "read-tree failed" };

        if (input.patchFile) {
          const ap = await git(["apply", "--cached", "--", input.patchFile], cwd, env);
          if (!ap.ok) return { sha: null, error: ap.err || "git apply --cached failed" };
        }
        if (add.length > 0) {
          const u = await git(["update-index", "--add", "--", ...add], cwd, env);
          if (!u.ok) return { sha: null, error: u.err || "update-index (add) failed" };
        }
        if (remove.length > 0) {
          const u = await git(["update-index", "--force-remove", "--", ...remove], cwd, env);
          if (!u.ok) return { sha: null, error: u.err || "update-index (remove) failed" };
        }

        const tree = await git(["write-tree"], cwd, env);
        if (!tree.ok || !tree.out) return { sha: null, error: tree.err || "write-tree failed" };

        // Refuse a no-op commit (resulting tree identical to HEAD's tree).
        const oldTree = await git(["rev-parse", `${old}^{tree}`], cwd);
        if (oldTree.ok && oldTree.out === tree.out) {
          return { sha: null, error: "no changes to commit (tree matches HEAD)" };
        }

        // commit-tree never consults the porcelain index or runs commit hooks.
        const made = await git(["commit-tree", tree.out, "-p", old, "-m", msg], cwd, env);
        if (!made.ok || !made.out) return { sha: null, error: made.err || "commit-tree failed" };
        const newSha = made.out;

        // Land the branch only if it still points at `old` — atomic compare-and-swap.
        const upd = await git(["update-ref", ref, newSha, old], cwd);
        if (!upd.ok) continue; // HEAD moved under us; rebuild onto the new tip.

        // Resync only the paths we committed so they show clean; other staged work stays put.
        const touched = [...add, ...remove, ...(await pathsInPatch(cwd, input.patchFile))];
        if (touched.length > 0) await git(["reset", "-q", "--", ...touched], cwd);

        return { sha: newSha, error: null };
      } finally {
        await unlink(idx).catch(() => {});
      }
    }
    return { sha: null, error: "HEAD moved repeatedly during commit; retry" };
  },
};
