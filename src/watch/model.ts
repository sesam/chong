import { checkState, mergeBranches, parseGitHubSlug } from "./gh";
import { repo } from "./repo";
import type { Gap, Lane, Pipeline } from "./types";

const QUEUE_LIMIT = 50; // max commits to list per gap
const INCOMING_LIMIT = 15; // recent commits shown for the head lane

// keys the TUI binds to other actions — gap hotkeys must avoid these
const RESERVED_KEYS = new Set(["q", "f", "r", "m", "j", "k", "y", "n", " "]);

/**
 * One promote hotkey per gap, indexed alongside `gaps`. Prefers the first letter of
 * the target branch (stage→"s", prod→"p"); falls back to the 1-based gap number on
 * collision or when the letter is reserved/non-alphabetic.
 */
export function gapHotkeys(gaps: Gap[]): string[] {
  const used = new Set<string>();
  return gaps.map((g, i) => {
    const letter = g.to[0]?.toLowerCase() ?? "";
    if (/^[a-z]$/.test(letter) && !RESERVED_KEYS.has(letter) && !used.has(letter)) {
      used.add(letter);
      return letter;
    }
    const digit = String(i + 1);
    used.add(digit);
    return digit;
  });
}

export type WatchConfig = {
  repoPath: string;
  remote: string;
  branches: string[]; // ordered upstream → downstream
  formatCmd: string; // command to run for code formatting (default: "pnpm format")
  testCmd: string; // command to run the unit tests (default: "pnpm test")
  i18nCmd: string; // command to run i18n extraction (default: "pnpm i18n")
};

/** Outcome of an auto-fast-forward attempt on one local branch ref. */
export type LocalSync = {
  branch: string;
  behind: number; // how many commits the local ref was behind origin
  toShort: string; // short sha the ref was (or would be) advanced to
  originSha: string; // full target sha — used by the caller to de-dupe notices
  ok: boolean; // the local ref was fast-forwarded
  blocked: boolean; // a fast-forward was possible but local changes prevented it
  reason?: string; // detail when blocked / failed
};

/**
 * Fast-forward local refs for the downstream tracked branches (everything below the
 * head lane — e.g. stage, prod) up to their origin counterparts, when it's safe:
 *
 *  - the local branch exists and is strictly behind origin by a fast-forward
 *    (origin is a descendant — no divergence / local-only commits), and
 *  - either the branch isn't checked out in any worktree (we move the ref directly),
 *    or it is checked out but the worktree changes don't conflict with the incoming
 *    files (git's `--ff-only` merge fast-forwards, or aborts harmlessly if they do).
 *
 * The head lane (the branch you actively develop on) is intentionally left alone.
 * Assumes refs were just fetched. Never rewrites history and never discards work.
 */
export async function syncLocalBranches(cfg: WatchConfig): Promise<LocalSync[]> {
  const { repoPath, remote, branches } = cfg;
  const results: LocalSync[] = [];

  for (const branch of branches.slice(1)) {
    const localSha = await repo.localSha(repoPath, branch);
    if (!localSha) continue; // not tracked locally — nothing to fast-forward

    const originSha = await repo.tip(repoPath, remote, branch);
    if (!originSha || originSha === localSha) continue; // missing or already in sync

    // Only fast-forwardable updates: origin must be a strict descendant of local.
    if (!(await repo.isAncestor(repoPath, localSha, originSha))) continue; // diverged

    const behind = await repo.behindCount(repoPath, localSha, originSha);
    const base = {
      branch,
      behind,
      toShort: originSha.slice(0, 7),
      originSha,
    };

    const worktree = await repo.worktreeFor(repoPath, branch);
    const err =
      worktree === null
        ? await repo.updateLocalRef(repoPath, branch, originSha, localSha)
        : await repo.mergeFastForward(worktree, remote, branch);

    results.push(
      err === null
        ? { ...base, ok: true, blocked: false }
        : { ...base, ok: false, blocked: true, reason: err },
    );
  }

  return results;
}

/** Fetch refs and assemble the full pipeline state (without CI — see enrichCI). */
export async function computePipeline(
  cfg: WatchConfig,
): Promise<{ pipeline: Pipeline | null; error: string | null; synced: LocalSync[] }> {
  const { repoPath, remote, branches } = cfg;

  const fetchErr = await repo.fetch(repoPath, remote, branches);
  // A failed fetch isn't fatal — we can still show the last-known local refs.

  // Keep local downstream refs (stage/prod) in step with origin when it's safe.
  // Done before reading branch state so the pipeline reflects the post-sync refs.
  const synced = fetchErr ? [] : await syncLocalBranches(cfg);

  const present = await repo.existingRemoteBranches(repoPath, remote, branches);
  if (present.length === 0) {
    return {
      pipeline: null,
      error:
        fetchErr ??
        `none of [${branches.join(", ")}] exist on ${remote} — pass --branches to set the right names`,
      synced,
    };
  }

  const ghRepo = parseGitHubSlug(await repo.remoteUrl(repoPath, remote));

  const lanes: Lane[] = [];
  for (const name of present) {
    const tip = await repo.tip(repoPath, remote, name);
    const commit = await repo.commitMeta(repoPath, tip);
    lanes.push({ name, tip, short: tip.slice(0, 7), commit, ci: "unknown" });
  }

  const gaps = [];
  for (let i = 0; i < present.length - 1; i++) {
    const from = present[i];
    const to = present[i + 1];
    const { ahead, behind } = await repo.aheadBehind(repoPath, remote, from, to);
    const ff = await repo.isFastForward(repoPath, remote, from, to);
    const queued = ahead > 0 ? await repo.logBetween(repoPath, remote, from, to, QUEUE_LIMIT) : [];
    gaps.push({ from, to, ahead, behind, ff, queued });
  }

  const incoming = await repo.recentLog(repoPath, remote, present[0], INCOMING_LIMIT);
  const localBranch = await repo.currentBranch(repoPath);
  const localCommits = await repo.localRecentLog(repoPath, localBranch, INCOMING_LIMIT);

  return {
    pipeline: {
      repoPath,
      remote,
      ghRepo,
      lanes,
      gaps,
      incoming,
      localBranch,
      localCommits,
      fetchedAt: Date.now(),
    },
    error: fetchErr, // surfaced as a non-fatal warning
    synced,
  };
}

/** Fill in CI status for each lane tip via gh. Best-effort; mutates lanes in place. */
export async function enrichCI(pipeline: Pipeline): Promise<void> {
  if (!pipeline.ghRepo) return;
  await Promise.all(
    pipeline.lanes.map(async (lane) => {
      lane.ci = await checkState(pipeline.ghRepo as string, lane.tip, pipeline.repoPath);
    }),
  );
}

/**
 * Promote the upstream branch of `gapIndex` onto its downstream branch.
 *
 * Fast-forward by default (direct push, linear history). When the branches have
 * diverged a fast-forward is impossible; we only create a merge commit if the
 * caller has explicitly opted in via `allowMerge` (the UI requires a separate,
 * clearly-worded confirmation for that). Returns null on success, else a message.
 */
export async function promote(
  pipeline: Pipeline,
  gapIndex: number,
  allowMerge = false,
): Promise<string | null> {
  const gap = pipeline.gaps[gapIndex];
  if (!gap) return "no such promotion";
  if (gap.ahead === 0) return `${gap.from} → ${gap.to}: nothing to promote`;

  if (gap.ff) {
    return repo.pushFastForward(pipeline.repoPath, pipeline.remote, gap.from, gap.to);
  }
  if (!allowMerge) {
    return `${gap.from} → ${gap.to} is not a fast-forward (${gap.to} has ${gap.behind} commit(s) ${gap.from} lacks) — reconcile first, or confirm a merge`;
  }
  if (!pipeline.ghRepo) {
    return `${gap.from} and ${gap.to} have diverged (${gap.behind} behind) — can't fast-forward, and no GitHub remote to merge through`;
  }
  return mergeBranches(pipeline.ghRepo, gap.to, gap.from, pipeline.repoPath);
}
