import type { Commit } from "./types";

type Run = { ok: boolean; out: string; err: string; code: number };

async function git(args: string[], cwd: string): Promise<Run> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim(), code };
}

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
};
