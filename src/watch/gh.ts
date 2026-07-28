import type { CIState } from "./types";

async function gh(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** Parse "OWNER/REPO" from a GitHub remote URL, or null for non-GitHub remotes. */
export function parseGitHubSlug(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/**
 * Package names with a dismissed Dependabot alert (Security tab) in this repo — the single
 * source of truth for "reviewed, not applicable here" instead of a hardcoded exception list
 * (mirrors the same live lookup in each watched repo's own dependency security-check script).
 * `-f`/`-F` on `gh api` switch the request to POST unless `--method GET` is explicit, so that
 * flag is required here even for a read. Best-effort: an empty set on any failure
 * (unauthenticated, no security_events scope, network) fails open — nothing extra gets
 * exempted, dep bumps just fall back to the normal age/vetting policy.
 */
export async function fetchDismissedPackageNames(slug: string, cwd: string): Promise<Set<string>> {
  const r = await gh(
    [
      "api",
      "--method",
      "GET",
      "--paginate",
      `repos/${slug}/dependabot/alerts`,
      "-f",
      "state=dismissed",
      "--jq",
      ".[].dependency.package.name",
    ],
    cwd,
  );
  if (!r.ok) return new Set();
  return new Set(
    r.out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

type CheckRun = { status: string; conclusion: string | null };

const FAIL_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/** Aggregate GitHub check-runs for a commit into a single CI state. Best-effort. */
export async function checkState(slug: string, sha: string, cwd: string): Promise<CIState> {
  const r = await gh(
    [
      "api",
      `repos/${slug}/commits/${sha}/check-runs`,
      "--jq",
      ".check_runs[] | {status, conclusion}",
    ],
    cwd,
  );
  if (!r.ok) return "unknown";
  if (!r.out) return "none";
  let runs: CheckRun[];
  try {
    // --jq emits one JSON object per line
    runs = r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CheckRun);
  } catch {
    return "unknown";
  }
  if (runs.length === 0) return "none";
  if (runs.some((x) => x.status !== "completed")) return "pending";
  if (runs.some((x) => x.conclusion && FAIL_CONCLUSIONS.has(x.conclusion))) return "fail";
  return "pass";
}

/**
 * Merge `head` into `base` on GitHub (creates a merge commit server-side). Used to
 * promote when the branches have diverged and a fast-forward isn't possible.
 * Returns null on success (or "nothing to merge"), else an error message.
 */
export async function mergeBranches(
  slug: string,
  base: string,
  head: string,
  cwd: string,
): Promise<string | null> {
  const r = await gh(
    ["api", `repos/${slug}/merges`, "-f", `base=${base}`, "-f", `head=${head}`],
    cwd,
  );
  if (r.ok) return null;
  // 204 = already merged → gh prints nothing and exits 0, so this is a real error
  if (/409|merge conflict/i.test(r.err)) return `merge conflict promoting ${head} → ${base}`;
  return r.err || "gh merge failed";
}
