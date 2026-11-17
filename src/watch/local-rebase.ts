import { existsSync } from "node:fs";
import path from "node:path";
import type { LocalSync } from "./model";
import { repo } from "./repo";

type Run = { ok: boolean; out: string; err: string };

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
  return { ok: (await proc.exited) === 0, out: out.trim(), err: err.trim() };
}

const firstLine = (s: string, fallback: string): string =>
  s
    .split("\n")
    .find(Boolean)
    ?.replace(/^(error|fatal): /, "") ?? fallback;

/** Refuse runaway replays — a local branch this far off origin wants a human. */
const MAX_REPLAY = 50;

/** Markers for an operation a human or another agent is in the middle of. */
const IN_PROGRESS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

async function operationInProgress(cwd: string): Promise<boolean> {
  for (const name of IN_PROGRESS) {
    const r = await git(["rev-parse", "--git-path", name], cwd);
    if (!r.ok || !r.out) continue;
    if (existsSync(path.isAbsolute(r.out) ? r.out : path.join(cwd, r.out))) return true;
  }
  return false;
}

type Replay = { tip: string; rewritten: Array<[string, string]> } | { error: string };

/**
 * Rebase `head`'s local-only commits onto `onto` WITHOUT touching any working tree or
 * index: each commit is three-way merged in memory (`git merge-tree --write-tree`) and
 * sealed with `commit-tree`. Any conflict returns an error and leaves nothing behind but
 * unreachable objects. Like `git rebase`, commits whose patch is already on `onto` are
 * dropped (by patch-id via `git cherry`, or because the replay comes out empty).
 *
 * Author *and* committer identity/dates are carried over, so the result is a pure
 * function of (onto, head): two watchers replaying the same commits build the same SHAs,
 * and the inject grace window (keyed on committer date) is not restarted by a rebase.
 */
export async function replayOnto(cwd: string, onto: string, head: string): Promise<Replay> {
  const merges = await git(["rev-list", "--count", "--merges", `${onto}..${head}`], cwd);
  if (!merges.ok) return { error: firstLine(merges.err, "rev-list failed") };
  if (merges.out !== "0") return { error: "local merge commit — rebase manually" };

  const cherry = await git(["cherry", onto, head], cwd);
  if (!cherry.ok) return { error: firstLine(cherry.err, "git cherry failed") };
  const picks = cherry.out
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1).trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
  if (picks.length > MAX_REPLAY) {
    return { error: `${picks.length} local commits exceed auto-rebase limit (${MAX_REPLAY})` };
  }

  let tip = onto;
  const rewritten: Array<[string, string]> = [];
  for (const sha of picks) {
    const short = sha.slice(0, 7);
    const merged = await git(
      ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${sha}^`, tip, sha],
      cwd,
    );
    const tree = merged.out.split("\n")[0] ?? "";
    if (!merged.ok || !/^[0-9a-f]{40,64}$/.test(tree)) {
      // Exit 1 with a tree on stdout is a content conflict; anything else is git itself.
      return {
        error: merged.out
          ? `${short} conflicts with origin`
          : firstLine(merged.err, "merge-tree failed"),
      };
    }
    if (tree === (await repo.treeOf(cwd, tip))) continue; // already on origin in another shape

    const meta = await git(
      ["log", "-1", "--date=raw", "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%B", sha],
      cwd,
    );
    const [an, ae, ad, cn, ce, cd, ...body] = meta.out.split("\0");
    if (!meta.ok || cd === undefined) return { error: `could not read ${short}` };
    const made = await git(["commit-tree", tree, "-p", tip, "-m", body.join("\0")], cwd, {
      GIT_AUTHOR_NAME: an,
      GIT_AUTHOR_EMAIL: ae,
      GIT_AUTHOR_DATE: ad,
      GIT_COMMITTER_NAME: cn,
      GIT_COMMITTER_EMAIL: ce,
      GIT_COMMITTER_DATE: cd,
    });
    if (!made.ok || !made.out) return { error: firstLine(made.err, "commit-tree failed") };
    rewritten.push([sha, made.out]);
    tip = made.out;
  }
  return { tip, rewritten };
}

/**
 * Move `branch` from `oldSha` to `newSha`, carrying its checked-out worktree (if any)
 * along the way `git checkout` would: uncommitted and untracked work is preserved, and
 * if any of it overlaps a file that differs between the two commits nothing moves at all.
 *
 * The ref update is a compare-and-swap on `oldSha`, so a commit another session lands
 * mid-flight is never dropped — we just lose the race and try again next poll. (That is
 * why this is not `git reset --keep`, which would happily move the branch off it.)
 */
async function moveBranch(
  cwd: string,
  worktree: string | null,
  branch: string,
  oldSha: string,
  newSha: string,
  reflog: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  if (worktree === null) {
    const r = await git(["update-ref", "-m", reflog, ref, newSha, oldSha], cwd);
    return r.ok ? null : firstLine(r.err, "update-ref failed");
  }

  // read-tree compares stat info, not content — refresh so a merely-touched file passes.
  await git(["update-index", "-q", "--refresh"], worktree);
  const dry = await git(["read-tree", "-n", "-m", "-u", oldSha, newSha], worktree);
  if (!dry.ok) return firstLine(dry.err, "local changes overlap incoming files");

  const moved = await git(["update-ref", "-m", reflog, ref, newSha, oldSha], worktree);
  if (!moved.ok) return `${branch} moved during sync — retrying next poll`;

  const applied = await git(["read-tree", "-m", "-u", oldSha, newSha], worktree);
  if (!applied.ok) {
    // Lost a race after the dry run (a file changed, or the index was locked). The tree
    // is untouched, so put the ref back — unless someone has already built on it.
    await git(["update-ref", "-m", `${reflog} (undone)`, ref, oldSha, newSha], worktree);
    return firstLine(applied.err, "could not update the working tree");
  }
  return null;
}

/**
 * Bring the local head-lane branch (the one you develop on, e.g. `main`) up to the
 * freshly fetched `remote/branch` — only when that is clean:
 *
 *  - strictly behind → fast-forward
 *  - diverged        → rebase the local-only commits onto origin (see {@link replayOnto})
 *  - only ahead      → nothing; landing those is `reconcileLocalMain`'s job
 *
 * "Clean" means no replay conflict, no local merge commits, no rebase/merge/cherry-pick
 * already in progress, and no uncommitted or untracked file in the way. Otherwise the
 * branch, index and working tree are left exactly as they were and the reason is
 * reported. Never stashes, never resets, never discards work.
 */
export async function syncHeadBranch(
  repoPath: string,
  remote: string,
  branch: string,
): Promise<LocalSync | null> {
  const localSha = await repo.localSha(repoPath, branch);
  if (!localSha) return null;
  const originSha = await repo.tip(repoPath, remote, branch);
  if (!originSha || originSha === localSha) return null;
  if (await repo.isAncestor(repoPath, originSha, localSha)) return null; // ahead only

  const worktree = await repo.worktreeFor(repoPath, branch);
  // Also check repoPath: mid-rebase HEAD is detached, so `branch` looks checked out nowhere.
  if (await operationInProgress(repoPath)) return null;
  if (worktree && (await operationInProgress(worktree))) return null;

  const base = {
    branch,
    behind: await repo.behindCount(repoPath, localSha, originSha),
    originSha,
    localSha,
  };
  const blocked = (reason: string): LocalSync => ({
    ...base,
    toShort: originSha.slice(0, 7),
    ok: false,
    blocked: true,
    reason,
  });

  let newTip = originSha;
  let rewritten: Array<[string, string]> | undefined;
  if (!(await repo.isAncestor(repoPath, localSha, originSha))) {
    const replay = await replayOnto(repoPath, originSha, localSha);
    if ("error" in replay) return blocked(replay.error);
    newTip = replay.tip;
    rewritten = replay.rewritten;
  }

  const err = await moveBranch(
    repoPath,
    worktree,
    branch,
    localSha,
    newTip,
    `chong watch: ${rewritten ? "rebase onto" : "fast-forward to"} ${remote}/${branch}`,
  );
  if (err) return blocked(err);
  return { ...base, toShort: newTip.slice(0, 7), ok: true, blocked: false, rewritten };
}
