export type CIState = "pass" | "fail" | "pending" | "none" | "unknown";

export type Commit = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  rel: string; // relative time, e.g. "2m", "3h"
  iso: string;
};

/** One branch in the promotion pipeline (e.g. main, stage, prod). */
export type Lane = {
  name: string;
  tip: string; // full sha of the remote tip
  short: string;
  commit: Commit | null;
  ci: CIState;
};

/** The space between two consecutive lanes (upstream → downstream). */
export type Gap = {
  from: string; // upstream lane name (source of promotion)
  to: string; // downstream lane name (target of promotion)
  ahead: number; // commits on `from` not yet on `to` — queued to promote
  behind: number; // commits on `to` not on `from` — drift (e.g. hotfix on prod)
  ff: boolean; // can promote by fast-forward (to is an ancestor of from)
  queued: Commit[]; // the `ahead` commits, newest first
};

export type Pipeline = {
  repoPath: string;
  remote: string;
  ghRepo: string | null; // "OWNER/REPO" when origin is GitHub, else null
  lanes: Lane[]; // ordered upstream → downstream
  gaps: Gap[]; // between consecutive lanes; gaps[i] sits between lanes[i] and lanes[i+1]
  incoming: Commit[]; // recent commits on the head (most-upstream) remote lane
  localBranch: string; // current branch name in the watched repo
  localCommits: Commit[]; // recent commits on the local branch
  fetchedAt: number; // epoch ms of last successful fetch
};
