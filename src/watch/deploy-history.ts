/**
 * Local record of what shipped, when.
 *
 * "What deployed when" used to be answerable only from GitHub Actions job history, which
 * does not see local deploys at all — and local is how stage actually ships. This keeps a
 * tab-separated log next to the repo's other chong state, one row per event.
 *
 * Two kinds of row land here:
 *   - `ci` / `production` — written by FRONTEND's scripts/deploy-frontend.sh, which is the
 *     only place that can time the build and the upload separately and measure dist size.
 *     chong points that script at this file via DEPLOY_HISTORY_FILE, because it builds in a
 *     throwaway shadow worktree and the row would otherwise be discarded with it.
 *   - `prod-promote` — written here. chong does not deploy prod; it pushes a SHA onto the
 *     `prod` branch and GitHub Actions deploys it. That push is the moment prod was
 *     triggered, and it is worth a local row even though the deploy finishes elsewhere.
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

export const HISTORY_FILENAME = "deploy-history.txt";

const HEADER = "# timestamp\ttarget\ttree\tcommit\twho\tbuild_s\tdeploy_s\tsize_kb\n";

/** Where the log lives for a repo. Kept in `.chong/`, which is already git-ignored. */
export function deployHistoryPath(repoPath: string): string {
  return path.join(repoPath, ".chong", HISTORY_FILENAME);
}

export type DeployHistoryRow = {
  /** Deploy target, or `prod-promote` for a push that triggers the prod pipeline. */
  target: string;
  tree: string;
  commit: string;
  who: string;
  /** Seconds, or null when this event has no such phase (a promote builds nothing). */
  buildSeconds?: number | null;
  deploySeconds?: number | null;
  sizeKb?: number | null;
};

/** A field that would corrupt the TSV is neutralised rather than escaped — these are logs. */
function field(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-";
  return (
    String(v)
      .replace(/[\t\r\n]+/g, " ")
      .trim() || "-"
  );
}

/**
 * Append one row. Never throws: this is a log, and losing a line must not fail a deploy
 * that already succeeded. Returns an error message for the caller to surface, or null.
 */
export function appendDeployHistory(repoPath: string, row: DeployHistoryRow): string | null {
  const file = deployHistoryPath(repoPath);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const fresh = !existsSync(file) || statSync(file).size === 0;
    const line = [
      new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      row.target,
      row.tree,
      row.commit,
      row.who,
      row.buildSeconds,
      row.deploySeconds,
      row.sizeKb,
    ]
      .map(field)
      .join("\t");
    appendFileSync(file, `${fresh ? HEADER : ""}${line}\n`, "utf8");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
