/**
 * GitHub API client for `chong watch`.
 *
 * Designed to keep background CI polling nearly free on GitHub's 5,000/hr rate limits
 * (drawing on T3 Code's GitHub quota work):
 *   - Talks directly to `https://api.github.com` via `fetch()` using a cached token
 *     (`GH_TOKEN` / `GITHUB_TOKEN`, or a one-time `gh auth token`), avoiding `gh` CLI
 *     process spawns on every poll. Falls back to `gh` CLI (with hard timeouts) when no
 *     token is available or on non-github.com hosts.
 *   - Batches multiple uncached SHAs on one repository into a single aliased GraphQL
 *     query (1 point for all lanes combined), reading `rateLimit` in the same round-trip.
 *   - Uses REST with conditional `If-None-Match` (`ETag`) when re-checking single/pending
 *     SHAs — `304 Not Modified` costs 0 rate-limit points.
 *   - Caches terminal verdicts (`pass` 30m, `fail` 5m), backs off `none` exponentially
 *     (30s → 15m), throttles `pending` to 30s, coalesces in-flight reads, and enforces a
 *     10% quota reserve so background polling never starves interactive `gh` usage.
 */
import type { CIState } from "./types";

const GH_CLI_TIMEOUT_MS = 30_000;
const GH_HTTP_TIMEOUT_MS = 15_000;
const CI_CACHE_MAX = 512;

const PASS_TTL_MS = 30 * 60_000;
const FAIL_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 30_000;
const UNKNOWN_TTL_MS = 60_000;
const NONE_BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];

const FAIL_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

type CheckRun = { status?: string; conclusion?: string | null };
type StatusContextNode = { state?: string };

type QuotaBucket = {
  limit: number;
  remaining: number;
  resetAtMs: number;
};

type CacheEntry = {
  state: CIState;
  etag?: string;
  fetchedAt: number;
  expiresAt: number;
  noneHits: number;
};

const ciCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CIState>>();
const quota: { rest: QuotaBucket | null; graphql: QuotaBucket | null } = {
  rest: null,
  graphql: null,
};

let cachedToken: { value: string | null; checkedAt: number } | null = null;
const TOKEN_MISS_TTL_MS = 5 * 60_000;

/** Reset internal caches & rate-limit state (for tests). */
export function resetGhCacheForTest(): void {
  ciCache.clear();
  inFlight.clear();
  quota.rest = null;
  quota.graphql = null;
  cachedToken = null;
}

/** Read current observed GitHub API quota (for diagnostics/tests). */
export function observedGitHubQuota(): { rest: QuotaBucket | null; graphql: QuotaBucket | null } {
  return {
    rest: quota.rest ? { ...quota.rest } : null,
    graphql: quota.graphql ? { ...quota.graphql } : null,
  };
}

function isQuotaPaused(kind: "rest" | "graphql", now = Date.now(), force = false): boolean {
  const b = quota[kind];
  if (!b) return false;
  if (now >= b.resetAtMs) return false;
  const reserve = force ? 5 : Math.max(50, Math.floor(b.limit * 0.1));
  return b.remaining <= reserve;
}

function observeRestHeaders(headers: Headers): void {
  const lim = Number.parseInt(headers.get("x-ratelimit-limit") ?? "", 10);
  const rem = Number.parseInt(headers.get("x-ratelimit-remaining") ?? "", 10);
  const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  if (Number.isFinite(lim) && Number.isFinite(rem) && Number.isFinite(reset)) {
    quota.rest = { limit: lim, remaining: rem, resetAtMs: reset * 1000 };
  }
}

function observeGraphqlRateLimit(
  rl: { limit?: number; remaining?: number; resetAt?: string } | undefined,
): void {
  if (!rl || typeof rl.limit !== "number" || typeof rl.remaining !== "number" || !rl.resetAt)
    return;
  const resetAtMs = Date.parse(rl.resetAt);
  if (Number.isFinite(resetAtMs)) {
    quota.graphql = { limit: rl.limit, remaining: rl.remaining, resetAtMs };
  }
}

function setCacheEntry(key: string, entry: CacheEntry): void {
  if (ciCache.has(key)) ciCache.delete(key);
  ciCache.set(key, entry);
  if (ciCache.size > CI_CACHE_MAX) {
    const oldest = ciCache.keys().next().value;
    if (oldest !== undefined) ciCache.delete(oldest);
  }
}

function computeExpiry(
  state: CIState,
  prevNoneHits: number,
  now: number,
): { expiresAt: number; noneHits: number } {
  if (state === "pass") return { expiresAt: now + PASS_TTL_MS, noneHits: 0 };
  if (state === "fail") return { expiresAt: now + FAIL_TTL_MS, noneHits: 0 };
  if (state === "pending") return { expiresAt: now + PENDING_TTL_MS, noneHits: 0 };
  if (state === "none") {
    const idx = Math.min(prevNoneHits, NONE_BACKOFF_MS.length - 1);
    return { expiresAt: now + NONE_BACKOFF_MS[idx], noneHits: prevNoneHits + 1 };
  }
  return { expiresAt: now + UNKNOWN_TTL_MS, noneHits: prevNoneHits };
}

/**
 * Run `gh` CLI with a hard timeout and full pipe draining. Never throws on ENOENT or
 * spawn failure — returns `{ ok: false }` so callers degrade cleanly.
 */
async function gh(
  args: string[],
  cwd: string,
  timeoutMs = GH_CLI_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const proc = Bun.spawn(["gh", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode !== null && proc.killed) {
      return { ok: false, out: out.trim(), err: `gh ${args[0]} timed out` };
    }
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

/** Resolve a GitHub API token (env var first, else one cached `gh auth token` call). */
async function resolveGitHubToken(cwd: string): Promise<string | null> {
  if (process.env.GH_HOST && process.env.GH_HOST !== "github.com") return null;
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const now = Date.now();
  if (cachedToken) {
    if (cachedToken.value !== null) return cachedToken.value;
    if (now - cachedToken.checkedAt < TOKEN_MISS_TTL_MS) return null;
  }
  const r = await gh(["auth", "token"], cwd, 5_000);
  const value = r.ok && r.out ? r.out.split("\n")[0].trim() : null;
  cachedToken = { value, checkedAt: now };
  return value;
}

/** Parse "OWNER/REPO" from a GitHub remote URL, or null for non-GitHub remotes. */
export function parseGitHubSlug(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/** Aggregate check runs (REST or GraphQL shapes) into a single CIState. */
export function aggregateCheckRuns(runs: CheckRun[]): CIState {
  if (runs.length === 0) return "none";
  if (runs.some((x) => (x.status ?? "").toLowerCase() !== "completed")) return "pending";
  if (runs.some((x) => x.conclusion && FAIL_CONCLUSIONS.has(x.conclusion))) return "fail";
  return "pass";
}

function aggregateGraphqlRollup(
  rollup:
    | {
        state?: string;
        contexts?: { nodes?: Array<CheckRun & StatusContextNode> };
      }
    | null
    | undefined,
): CIState {
  if (!rollup) return "none";
  const nodes = rollup.contexts?.nodes ?? [];
  if (nodes.length > 0) {
    let anyPending = false;
    let anyFail = false;
    for (const n of nodes) {
      if (typeof n.status === "string") {
        if (n.status.toUpperCase() !== "COMPLETED") anyPending = true;
        else if (n.conclusion && FAIL_CONCLUSIONS.has(n.conclusion)) anyFail = true;
      } else if (typeof n.state === "string") {
        const s = n.state.toUpperCase();
        if (s === "PENDING" || s === "EXPECTED") anyPending = true;
        else if (s === "FAILURE" || s === "ERROR") anyFail = true;
      }
    }
    if (anyPending) return "pending";
    if (anyFail) return "fail";
    return "pass";
  }
  const st = (rollup.state ?? "").toUpperCase();
  if (st === "SUCCESS") return "pass";
  if (st === "FAILURE" || st === "ERROR") return "fail";
  if (st === "PENDING" || st === "EXPECTED") return "pending";
  return "none";
}

async function restCheckState(
  slug: string,
  sha: string,
  token: string,
  prev: CacheEntry | undefined,
): Promise<{ state: CIState; etag?: string } | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "chong-watch",
  };
  if (prev?.etag) headers["If-None-Match"] = prev.etag;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${slug}/commits/${sha}/check-runs?per_page=100`,
      { headers, signal: AbortSignal.timeout(GH_HTTP_TIMEOUT_MS) },
    );
    observeRestHeaders(res.headers);
    if (res.status === 401) {
      cachedToken = null;
      return null;
    }
    if (res.status === 304 && prev) {
      // Conditional hit — 0 rate-limit points spent!
      return { state: prev.state, etag: res.headers.get("etag") ?? prev.etag };
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { check_runs?: CheckRun[] };
    const state = aggregateCheckRuns(data.check_runs ?? []);
    return { state, etag: res.headers.get("etag") ?? undefined };
  } catch {
    return null;
  }
}

async function graphqlCheckStatesBatch(
  slug: string,
  shas: string[],
  token: string,
): Promise<Map<string, CIState> | null> {
  const [owner, name] = slug.split("/");
  if (!owner || !name || shas.length === 0) return null;
  // Validate SHAs before embedding in aliases/variables so GraphQL stays well-formed.
  const valid = shas.filter((s) => /^[0-9a-f]{7,64}$/i.test(s));
  if (valid.length === 0) return null;

  const varDefs = ["$owner: String!", "$name: String!"];
  const variables: Record<string, string> = { owner, name };
  const fields: string[] = [];
  for (let i = 0; i < valid.length; i++) {
    const v = `sha${i}`;
    varDefs.push(`$${v}: GitObjectID!`);
    variables[v] = valid[i];
    fields.push(
      `c${i}: object(oid: $${v}) { ... on Commit { statusCheckRollup { state contexts(first: 50) { nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } }`,
    );
  }
  const query = `query(${varDefs.join(", ")}) { rateLimit { limit remaining resetAt } repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`;

  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "chong-watch",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GH_HTTP_TIMEOUT_MS),
    });
    if (res.status === 401) {
      cachedToken = null;
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        rateLimit?: { limit?: number; remaining?: number; resetAt?: string };
        repository?: Record<
          string,
          {
            statusCheckRollup?: {
              state?: string;
              contexts?: { nodes?: Array<CheckRun & StatusContextNode> };
            } | null;
          } | null
        >;
      };
      errors?: unknown[];
    };
    observeGraphqlRateLimit(body.data?.rateLimit);
    const repoObj = body.data?.repository;
    if (!repoObj) return null;
    const out = new Map<string, CIState>();
    for (let i = 0; i < valid.length; i++) {
      const node = repoObj[`c${i}`];
      out.set(valid[i], node ? aggregateGraphqlRollup(node.statusCheckRollup) : "none");
    }
    return out;
  } catch {
    return null;
  }
}

async function cliCheckState(slug: string, sha: string, cwd: string): Promise<CIState> {
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
  try {
    const runs = r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CheckRun);
    return aggregateCheckRuns(runs);
  } catch {
    return "unknown";
  }
}

/**
 * Package names with a dismissed Dependabot alert (Security tab) in this repo.
 * Uses direct REST API when a token is available, falling back to `gh api --paginate`.
 */
export async function fetchDismissedPackageNames(slug: string, cwd: string): Promise<Set<string>> {
  const token = await resolveGitHubToken(cwd);
  if (token && !isQuotaPaused("rest")) {
    try {
      const names = new Set<string>();
      let url: string | null =
        `https://api.github.com/repos/${slug}/dependabot/alerts?state=dismissed&per_page=100`;
      for (let page = 0; url && page < 10; page++) {
        const res: Response = await fetch(url, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "chong-watch",
          },
          signal: AbortSignal.timeout(GH_HTTP_TIMEOUT_MS),
        });
        observeRestHeaders(res.headers);
        if (!res.ok) break;
        const rows = (await res.json()) as Array<{ dependency?: { package?: { name?: string } } }>;
        for (const row of rows) {
          const n = row.dependency?.package?.name?.trim();
          if (n) names.add(n);
        }
        const link: string = res.headers.get("link") ?? "";
        const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
        url = nextMatch ? nextMatch[1] : null;
      }
      return names;
    } catch {
      /* fall through to CLI */
    }
  }

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

/**
 * Aggregate GitHub check-runs for a single commit into a CIState, with caching, ETag 304
 * conditional revalidation, rate-limit reserve guard, and in-flight coalescing.
 */
export async function checkState(
  slug: string,
  sha: string,
  cwd: string,
  opts: { force?: boolean } = {},
): Promise<CIState> {
  const key = `${slug}@${sha}`;
  const now = Date.now();
  const prev = ciCache.get(key);
  if (!opts.force && prev && now < prev.expiresAt) {
    return prev.state;
  }
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<CIState> => {
    const token = await resolveGitHubToken(cwd);
    if (token) {
      if (!isQuotaPaused("rest", Date.now(), opts.force)) {
        const res = await restCheckState(slug, sha, token, opts.force ? undefined : prev);
        if (res) {
          const ts = Date.now();
          const { expiresAt, noneHits } = computeExpiry(res.state, prev?.noneHits ?? 0, ts);
          setCacheEntry(key, {
            state: res.state,
            etag: res.etag,
            fetchedAt: ts,
            expiresAt,
            noneHits,
          });
          return res.state;
        }
      }
      if (!isQuotaPaused("graphql", Date.now(), opts.force)) {
        const batch = await graphqlCheckStatesBatch(slug, [sha], token);
        const st = batch?.get(sha);
        if (st) {
          const ts = Date.now();
          const { expiresAt, noneHits } = computeExpiry(st, prev?.noneHits ?? 0, ts);
          setCacheEntry(key, { state: st, etag: prev?.etag, fetchedAt: ts, expiresAt, noneHits });
          return st;
        }
      }
      if (
        isQuotaPaused("rest", Date.now(), opts.force) &&
        isQuotaPaused("graphql", Date.now(), opts.force)
      ) {
        return prev?.state ?? "unknown";
      }
    }

    const st = await cliCheckState(slug, sha, cwd);
    const ts = Date.now();
    const { expiresAt, noneHits } = computeExpiry(st, prev?.noneHits ?? 0, ts);
    setCacheEntry(key, { state: st, etag: prev?.etag, fetchedAt: ts, expiresAt, noneHits });
    return st;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, task);
  return task;
}

/**
 * Batch-resolve CI states for several SHAs on the same repository (`enrichCI`).
 *
 * Routing policy (inspired by T3 Code):
 *   - Fresh cache hits are returned immediately with zero network traffic.
 *   - Expired SHAs that already have an ETag go through REST (`If-None-Match` → 304 = 0 pts).
 *   - 2+ cold/uncached SHAs without ETags batch into a single aliased GraphQL query (1 pt total)
 *     when GraphQL quota has headroom; otherwise fall back to REST / `gh` CLI.
 */
export async function checkStatesBatch(
  slug: string,
  shas: string[],
  cwd: string,
  opts: { force?: boolean } = {},
): Promise<Map<string, CIState>> {
  const unique = [...new Set(shas.filter(Boolean))];
  const result = new Map<string, CIState>();
  const now = Date.now();

  const coldForGraphql: string[] = [];
  const individual: string[] = [];

  for (const sha of unique) {
    const key = `${slug}@${sha}`;
    const prev = ciCache.get(key);
    if (!opts.force && prev && now < prev.expiresAt) {
      result.set(sha, prev.state);
      continue;
    }
    if (!opts.force && prev?.etag) {
      individual.push(sha);
    } else {
      coldForGraphql.push(sha);
    }
  }

  const token = unique.length > result.size ? await resolveGitHubToken(cwd) : null;

  if (token && coldForGraphql.length >= 2 && !isQuotaPaused("graphql", now, opts.force)) {
    const batch = await graphqlCheckStatesBatch(slug, coldForGraphql, token);
    if (batch) {
      const ts = Date.now();
      for (const sha of coldForGraphql) {
        const st = batch.get(sha);
        if (st) {
          const prev = ciCache.get(`${slug}@${sha}`);
          const { expiresAt, noneHits } = computeExpiry(st, prev?.noneHits ?? 0, ts);
          setCacheEntry(`${slug}@${sha}`, {
            state: st,
            etag: prev?.etag,
            fetchedAt: ts,
            expiresAt,
            noneHits,
          });
          result.set(sha, st);
        } else {
          individual.push(sha);
        }
      }
    } else {
      individual.push(...coldForGraphql);
    }
  } else {
    individual.push(...coldForGraphql);
  }

  if (individual.length > 0) {
    await Promise.all(
      individual.map(async (sha) => {
        result.set(sha, await checkState(slug, sha, cwd, opts));
      }),
    );
  }

  return result;
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
  const token = await resolveGitHubToken(cwd);
  if (token) {
    try {
      const res = await fetch(`https://api.github.com/repos/${slug}/merges`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "chong-watch",
        },
        body: JSON.stringify({ base, head }),
        signal: AbortSignal.timeout(GH_HTTP_TIMEOUT_MS),
      });
      observeRestHeaders(res.headers);
      if (res.ok || res.status === 204) return null;
      if (res.status === 409) return `merge conflict promoting ${head} → ${base}`;
      if (res.status === 401) {
        cachedToken = null;
      } else {
        const text = await res.text().catch(() => "");
        return text.trim().slice(0, 200) || `gh merge failed (${res.status})`;
      }
    } catch {
      /* fall through to CLI */
    }
  }

  const r = await gh(
    ["api", `repos/${slug}/merges`, "-f", `base=${base}`, "-f", `head=${head}`],
    cwd,
  );
  if (r.ok) return null;
  // 204 = already merged → gh prints nothing and exits 0, so this is a real error
  if (/409|merge conflict/i.test(r.err)) return `merge conflict promoting ${head} → ${base}`;
  return r.err || "gh merge failed";
}
