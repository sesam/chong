import { checkState, mergeBranches, parseGitHubSlug } from "./gh";
import { repo } from "./repo";
import type { Gap, Lane, Pipeline } from "./types";

const QUEUE_LIMIT = 50; // max commits to list per gap
const INCOMING_LIMIT = 15; // recent commits shown for the head lane

// keys the TUI binds to other actions — gap hotkeys must avoid these
const RESERVED_KEYS = new Set(["q", "f", "r", "j", "k", "y", "n", " "]);

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
};

/** Fetch refs and assemble the full pipeline state (without CI — see enrichCI). */
export async function computePipeline(
  cfg: WatchConfig,
): Promise<{ pipeline: Pipeline | null; error: string | null }> {
  const { repoPath, remote, branches } = cfg;

  const fetchErr = await repo.fetch(repoPath, remote, branches);
  // A failed fetch isn't fatal — we can still show the last-known local refs.

  const present = await repo.existingRemoteBranches(repoPath, remote, branches);
  if (present.length === 0) {
    return {
      pipeline: null,
      error:
        fetchErr ??
        `none of [${branches.join(", ")}] exist on ${remote} — pass --branches to set the right names`,
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

  return {
    pipeline: {
      repoPath,
      remote,
      ghRepo,
      lanes,
      gaps,
      incoming,
      fetchedAt: Date.now(),
    },
    error: fetchErr, // surfaced as a non-fatal warning
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
