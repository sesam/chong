import { appendDeployHistory } from "./deploy-history";
import { checkStatesBatch, mergeBranches, parseGitHubSlug } from "./gh";
import { syncHeadBranch } from "./local-rebase";
import { repo } from "./repo";
import type { Gap, Lane, Pipeline } from "./types";
import { computeAkkPipeline, detectVcs } from "./vcs";

/** Cache `ghRepo` slug per (repoPath, remote) — remote URLs rarely change mid-watch. */
const ghRepoCache = new Map<string, string | null>();

/**
 * Log the prod push. chong does not deploy prod — it pushes a SHA onto `prod` and GitHub
 * Actions deploys it — so this records the trigger, not a finished deploy. Build/deploy
 * timings and size belong to the CI run and are left empty; the deploy-history row for the
 * completed prod deploy comes from scripts/deploy-frontend.sh when prod is shipped locally.
 */
async function recordProdPromote(repoPath: string, sha: string): Promise<void> {
  const [tree, who] = await Promise.all([repo.treeOf(repoPath, sha), repo.userName(repoPath)]);
  appendDeployHistory(repoPath, {
    target: "prod-promote",
    tree: tree ?? "unknown",
    commit: sha,
    who: who ?? process.env.USER ?? "unknown",
  });
}

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
  i18nScan: boolean; // scan commits for hardcoded strings not wrapped in t() (default: true)
  /** cursor-agent on cherry-pick conflicts + i18n (default true). */
  agent: boolean;
  /** Auto-run commit-producing maintain on start / every N commits / every 2h (default true). */
  autoMaintain: boolean;
  /**
   * Keep the local head-lane branch (and its working tree) on top of origin: fast-forward
   * when behind, rebase local-only commits when diverged — only when clean (default true).
   */
  autoRebase: boolean;
  /**
   * Local stage deploy with cooldown (default true when scripts/deploy-frontend.sh exists).
   * Does NOT git-push the stage branch — builds+uploads to app-ci from origin/main.
   */
  autoDeployStage: boolean;
  /** Quiet seconds on origin/main before auto stage deploy (default 60). */
  deployCooldownSec: number;
  /** Shell command for stage deploy; empty = auto-detect FRONTEND script. */
  stageDeployCmd: string;
  /**
   * Scan for import specifiers pointing at no file, and block the stage deploy on any
   * (default true). Catches broken lazy `import()`s, which `vite build` cannot — the chunk
   * only resolves on navigation, so the bundle builds and the route renders blank.
   */
  importScan: boolean;
  /**
   * Tip shown for the stage lane when autoDeployStage is on — normally the live
   * S3 marker (preferred) or the local `stage` branch. Kept in sync by
   * resolveLiveStageTip / markLocalStageDeployed.
   */
  stageDeployedSha: string | null;
  /**
   * Tip shown for the prod lane when a prod S3 marker bucket is configured and
   * reachable. Null ⇒ fall back to `origin/prod` (branch-based comparison).
   */
  prodDeployedSha: string | null;
  /** Run without a TTY / alt-screen TUI (for systemd / always-on VM daemons). */
  headless?: boolean;
  /** Override path for the rotating persistent watch log file (empty = default under ~/.chong/logs). */
  logFile?: string;
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
  localSha?: string; // head lane only: the local tip the sync started from
  /** Head lane only, set when it was rebased: [old, new] sha per replayed local commit. */
  rewritten?: Array<[string, string]>;
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
 * The head lane (the branch you actively develop on) is handled by `syncHeadBranch`.
 * Assumes refs were just fetched. Never rewrites history and never discards work.
 */
export async function syncLocalBranches(cfg: WatchConfig): Promise<LocalSync[]> {
  const { repoPath, remote, branches } = cfg;
  const results: LocalSync[] = [];
  const downstream = branches
    .slice(1)
    .filter((branch) => !(cfg.autoDeployStage && branch === "stage"));
  if (downstream.length === 0) return results;

  // Resolve all local + remote downstream refs in a single git call.
  const refs = await repo.resolveRefs(repoPath, [
    ...downstream.map((b) => `refs/heads/${b}`),
    ...downstream.map((b) => `refs/remotes/${remote}/${b}`),
  ]);

  for (const branch of downstream) {
    const localSha = refs.get(`refs/heads/${branch}`) ?? null;
    if (!localSha) continue; // not tracked locally — nothing to fast-forward

    const originSha = refs.get(`refs/remotes/${remote}/${branch}`) ?? "";
    if (!originSha || originSha === localSha) continue; // missing or already in sync

    // Only fast-forwardable updates: origin must be a strict descendant of local.
    if (!(await repo.isAncestor(repoPath, localSha, originSha))) continue; // diverged

    const [behind, worktree] = await Promise.all([
      repo.behindCount(repoPath, localSha, originSha),
      repo.worktreeFor(repoPath, branch),
    ]);
    const base = {
      branch,
      behind,
      toShort: originSha.slice(0, 7),
      originSha,
    };

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
  if (detectVcs(repoPath)?.kind === "akk") {
    return computeAkkPipeline(cfg);
  }

  const fetchErr = await repo.fetch(repoPath, remote, branches);
  // A failed fetch isn't fatal — we can still show the last-known local refs.

  // Keep local downstream refs (stage/prod) in step with origin when it's safe.
  // Done before reading branch state so the pipeline reflects the post-sync refs.
  const synced = fetchErr ? [] : await syncLocalBranches(cfg);
  // Then the head lane: fast-forward / rebase local `main` (and its working tree) onto
  // origin when that is clean. Before the inject below it in the poll, so a diverged
  // local branch normally becomes a plain linear push instead of a shadow cherry-pick.
  if (!fetchErr && cfg.autoRebase) {
    const head = await syncHeadBranch(repoPath, remote, branches[0]);
    if (head) synced.push(head);
  }

  // Resolve every remote branch + local stage ref in one `for-each-ref` subprocess.
  const refList = [
    ...branches.map((b) => `refs/remotes/${remote}/${b}`),
    ...(cfg.autoDeployStage ? ["refs/heads/stage"] : []),
  ];
  const resolvedRefs = await repo.resolveRefs(repoPath, refList);
  const present = branches.filter((b) => resolvedRefs.has(`refs/remotes/${remote}/${b}`));
  if (present.length === 0) {
    return {
      pipeline: null,
      error:
        fetchErr ??
        `none of [${branches.join(", ")}] exist on ${remote} — pass --branches to set the right names`,
      synced,
    };
  }

  const ghKey = `${repoPath}\0${remote}`;
  let ghRepo = ghRepoCache.get(ghKey);
  if (ghRepo === undefined) {
    ghRepo = parseGitHubSlug(await repo.remoteUrl(repoPath, remote));
    ghRepoCache.set(ghKey, ghRepo);
  }

  const laneTips = present
    .map((name) => {
      let tip = resolvedRefs.get(`refs/remotes/${remote}/${name}`) ?? "";
      // Local stage deploy: lane tip prefers the live marker / local tracker, not origin/stage.
      if (cfg.autoDeployStage && name === "stage") {
        const localTip = cfg.stageDeployedSha ?? resolvedRefs.get("refs/heads/stage") ?? null;
        if (localTip) tip = localTip;
      }
      // Live prod marker (S3) beats a stale origin/prod when a local/chong deploy shipped
      // without pushing the git ref.
      if (name === "prod" && cfg.prodDeployedSha) {
        tip = cfg.prodDeployedSha;
      }
      return tip ? { name, tip } : null;
    })
    .filter((x): x is { name: string; tip: string } => x !== null);

  // Fetch lane commit metadata, incoming log, and local branch in parallel.
  const [lanes, incoming, localBranch] = await Promise.all([
    Promise.all(
      laneTips.map(async ({ name, tip }): Promise<Lane> => {
        const commit = await repo.commitMeta(repoPath, tip);
        return { name, tip, short: tip.slice(0, 7), commit, ci: "unknown" };
      }),
    ),
    repo.recentLog(repoPath, remote, laneTips[0]?.name ?? present[0], INCOMING_LIMIT),
    repo.currentBranch(repoPath),
  ]);

  // Compute all gaps + local commits concurrently.
  const [gaps, localCommits] = await Promise.all([
    Promise.all(
      lanes.slice(0, -1).map(async (fromLane, i): Promise<Gap> => {
        const toLane = lanes[i + 1];
        const from = fromLane.name;
        const to = toLane.name;

        const useRawShas =
          (cfg.autoDeployStage && (from === "stage" || to === "stage")) ||
          (Boolean(cfg.prodDeployedSha) && (from === "prod" || to === "prod"));

        const [{ ahead, behind }, ff] = useRawShas
          ? await Promise.all([
              repo.aheadBehindShas(repoPath, fromLane.tip, toLane.tip),
              repo.isAncestor(repoPath, toLane.tip, fromLane.tip),
            ])
          : await Promise.all([
              repo.aheadBehind(repoPath, remote, from, to),
              repo.isFastForward(repoPath, remote, from, to),
            ]);

        const queued =
          ahead > 0
            ? useRawShas
              ? await repo.logBetweenShas(repoPath, fromLane.tip, toLane.tip, QUEUE_LIMIT)
              : await repo.logBetween(repoPath, remote, from, to, QUEUE_LIMIT)
            : [];
        return { from, to, ahead, behind, ff, queued };
      }),
    ),
    repo.localRecentLog(repoPath, localBranch, INCOMING_LIMIT),
  ]);

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

/**
 * Fill in CI status for each lane tip via GitHub API (batched GraphQL / conditional REST
 * with terminal verdict caching and rate-limit reserve). Best-effort; mutates lanes in place.
 */
export async function enrichCI(pipeline: Pipeline, opts: { force?: boolean } = {}): Promise<void> {
  if (!pipeline.ghRepo) return;
  const states = await checkStatesBatch(
    pipeline.ghRepo,
    pipeline.lanes.map((l) => l.tip),
    pipeline.repoPath,
    opts,
  );
  for (const lane of pipeline.lanes) {
    lane.ci = states.get(lane.tip) ?? "unknown";
  }
}

/**
 * Promote the upstream branch of `gapIndex` onto its downstream branch.
 *
 * Fast-forward by default (direct push, linear history). When the branches have
 * diverged a fast-forward is impossible; we only create a merge commit if the
 * caller has explicitly opted in via `allowMerge` (the UI requires a separate,
 * clearly-worded confirmation for that). Returns null on success, else a message.
 *
 * When `autoDeployStage` is on, promoting *to stage* is not done here (the watch
 * loop runs a local deploy instead). Promoting *to prod* pushes the stage lane's
 * tip SHA (last successful local deploy) onto `prod`, not origin/stage.
 */
export async function promote(
  pipeline: Pipeline,
  gapIndex: number,
  allowMerge = false,
  opts: { autoDeployStage?: boolean } = {},
): Promise<string | null> {
  const gap = pipeline.gaps[gapIndex];
  if (!gap) return "no such promotion";
  if (gap.ahead === 0) return `${gap.from} → ${gap.to}: nothing to promote`;

  if (opts.autoDeployStage && gap.to === "stage") {
    return "stage deploy is local — use confirm to run deploy (no git push)";
  }

  if (opts.autoDeployStage && gap.to === "prod") {
    // Push the virtual stage tip (last deployed) to prod — same SHA pushFastForward uses.
    const stageLane = pipeline.lanes.find((l) => l.name === "stage");
    const sha = stageLane?.tip;
    if (!sha) return "no stage tip to promote to prod";
    if (!gap.ff && !allowMerge) {
      return `${gap.from} → ${gap.to} is not a fast-forward (${gap.to} has ${gap.behind} commit(s) ${gap.from} lacks) — reconcile first, or confirm a merge`;
    }
    if (!gap.ff && allowMerge) {
      // Merge exactly the deployed stage tip (GitHub's merge API takes a commit sha as
      // `head`). This used to merge the `main` branch, which shipped every commit on
      // main to prod — including ones never deployed to stage.
      if (!pipeline.ghRepo) return "diverged prod promote needs a GitHub remote";
      const mergeErr = await mergeBranches(pipeline.ghRepo, gap.to, sha, pipeline.repoPath);
      if (!mergeErr) await recordProdPromote(pipeline.repoPath, sha);
      return mergeErr;
    }
    const pushErr = await repo.pushSha(pipeline.repoPath, pipeline.remote, "prod", sha);
    if (!pushErr) await recordProdPromote(pipeline.repoPath, sha);
    return pushErr;
  }

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
