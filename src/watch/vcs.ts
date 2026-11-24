/**
 * VCS abstraction supporting both Git repos and `akk` v4 repos (`.akk/config.json`).
 *
 * Git remains the primary path with zero behavioural changes. When a repo has `.akk/`
 * (and no `.git/`, or `CHONG_VCS=akk`), `chong verify`, `chong check i18n`, `chong commit`,
 * `chong deploy`, and `chong watch` operate cleanly against `akk` trunk + tags + 64-char
 * SHA-256 commit hashes instead of failing with "not a git repository".
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { LocalSync, WatchConfig } from "./model";
import { detectRepoProfile } from "./repo-profile";
import { readStreamCapped } from "./runtime";
import { sanitizeDisplayText } from "./sanitize-display";
import type { Commit, Gap, Lane, Pipeline } from "./types";
import {
  type WorktreeAcquireResult,
  acquireWorktreeClaim,
  formatWorktreeHolder,
} from "./worktree-claim";

export type VcsKind = "git" | "akk";

export type DetectedVcs = {
  kind: VcsKind;
  root: string;
  akkRepo?: string;
};

const AKK_TIMEOUT_MS = 60_000;
const WALK_SKIP = new Set([
  ".git",
  ".akk",
  ".chong",
  "node_modules",
  ".venv",
  ".wrangler",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".nuxt",
  "coverage",
]);

export type AkkConfig = {
  repo?: string;
  base?: string;
};

export function readAkkConfig(root: string): AkkConfig | null {
  const p = path.join(root, ".akk", "config.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as AkkConfig;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Walk upward from `startDir` to detect whether the workspace is managed by Git or `akk`.
 * Returns null if neither `.git` nor `.akk/config.json` is found.
 */
export function detectVcs(startDir: string): DetectedVcs | null {
  const preferAkk = process.env.CHONG_VCS === "akk";
  let dir = path.resolve(startDir);
  for (;;) {
    const hasGit = existsSync(path.join(dir, ".git"));
    const akkCfg = readAkkConfig(dir);
    if (preferAkk && akkCfg) return { kind: "akk", root: dir, akkRepo: akkCfg.repo };
    if (hasGit) return { kind: "git", root: dir };
    if (akkCfg) return { kind: "akk", root: dir, akkRepo: akkCfg.repo };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type AkkRun = { ok: boolean; out: string; err: string };

async function runAkk(args: string[], cwd: string, timeoutMs = AKK_TIMEOUT_MS): Promise<AkkRun> {
  try {
    const proc = Bun.spawn(["akk", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      env: { ...process.env },
    });
    const [out, err, code] = await Promise.all([
      readStreamCapped(proc.stdout, 256 * 1024),
      readStreamCapped(proc.stderr, 256 * 1024),
      proc.exited,
    ]);
    if (proc.signalCode !== null && proc.killed) {
      return { ok: false, out: out.trim(), err: `akk ${args[0]} timed out` };
    }
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

// ── pure parsers (unit-tested) ───────────────────────────────────────────────

export type AkkStatus = {
  repo: string;
  base: string;
  trunk: string;
  behind: boolean;
  changes: Array<{ status: string; path: string }>;
};

/**
 * Parse `akk status` output:
 *   myrepo base=abcdef0123 trunk=1234567890  (behind: akk pull)
 *     M src/index.ts
 *     A src/new.ts
 */
export function parseAkkStatus(raw: string): AkkStatus | null {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const head = lines[0].match(/^(\S+)\s+base=(\S+)\s+trunk=(\S+)(.*)$/);
  if (!head) return null;
  const [, repo, base, trunk, tail] = head;
  const changes: Array<{ status: string; path: string }> = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^\s+([A-Z?]+)\s+(.+)$/);
    if (m) changes.push({ status: m[1], path: m[2].trim() });
  }
  return {
    repo,
    base: base === "-" ? "" : base,
    trunk: trunk === "-" ? "" : trunk,
    behind: /behind/i.test(tail) || (base !== trunk && trunk !== "-"),
    changes,
  };
}

/**
 * Parse `akk log` output:
 *   abcdef0123 (current-stage)  2026-11-24 09:10  simon  fix login
 *   1234567890  2026-11-23 18:02  ana  add tests
 */
export function parseAkkLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(
      /^([0-9a-f]{7,64})(?:\s+\([^)]*\))?\s{2}(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s{2}(\S+)\s{2}(.*)$/i,
    );
    if (!m) continue;
    const [, sha, dt, author, subject] = m;
    const iso = `${dt.replace(" ", "T")}:00Z`;
    commits.push({
      sha: sha.toLowerCase(),
      short: sha.slice(0, 7).toLowerCase(),
      author: sanitizeDisplayText(author, 100),
      rel: shortRelFromIso(iso),
      iso,
      subject: sanitizeDisplayText(subject, 300),
    });
  }
  return commits;
}

function shortRelFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Parse `akk tags` output (`<name> <hash>`). */
export function parseAkkTags(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+([0-9a-f]{7,64})$/i);
    if (m) out.set(m[1], m[2].toLowerCase());
  }
  return out;
}

// ── workspace operations ─────────────────────────────────────────────────────

export async function akkChangedFiles(root: string): Promise<string[]> {
  const r = await runAkk(["status"], root);
  if (!r.ok) return [];
  const st = parseAkkStatus(r.out);
  if (!st) return [];
  return st.changes.filter((c) => c.status !== "D").map((c) => c.path);
}

export async function akkCommit(
  root: string,
  message: string,
): Promise<{ sha: string | null; error: string | null }> {
  const r = await runAkk(["commit", "-m", message], root);
  if (!r.ok) return { sha: null, error: r.err || r.out || "akk commit failed" };
  const m = r.out.match(/\[trunk\s+([0-9a-f]{7,64})\]/i);
  const cfg = readAkkConfig(root);
  return { sha: cfg?.base ?? m?.[1] ?? null, error: null };
}

export async function akkTag(
  root: string,
  name: string,
  ref: string,
  force = false,
): Promise<string | null> {
  const args = force ? ["tag", "-f", name, ref] : ["tag", name, ref];
  const r = await runAkk(args, root);
  return r.ok ? null : r.err || r.out || `akk tag ${name} failed`;
}

/** Walk files in a non-git / `akk` workspace, skipping standard build/VCS dirs. */
export async function listTrackedFiles(root: string, pathspec?: string): Promise<string[]> {
  const startAbs = pathspec ? path.resolve(root, pathspec) : root;
  const out: string[] = [];
  if (!existsSync(startAbs)) return out;
  try {
    const st = statSync(startAbs);
    if (st.isFile()) return [path.relative(root, startAbs)];
  } catch {
    return out;
  }

  const visit = (dirAbs: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (WALK_SKIP.has(name) || (name.startsWith(".") && name !== ".")) continue;
      const abs = path.join(dirAbs, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(abs);
      else if (st.isFile()) out.push(path.relative(root, abs));
    }
  };
  visit(startAbs);
  return out;
}

/**
 * Materialize an `akk` shadow directory at `ref` (trunk/tag/hash) under a worktree claim.
 * Symlinks `node_modules` / `.venv` from `repoPath` just like git shadow worktrees.
 */
export async function ensureAkkShadow(
  repoPath: string,
  shadowPath: string,
  ref: string,
  opts: { processId: string; forceWorktree?: boolean },
): Promise<{ shadowPath: string; error: string | null; claim: WorktreeAcquireResult }> {
  mkdirSync(path.dirname(shadowPath), { recursive: true });
  const claim = acquireWorktreeClaim(shadowPath, opts.processId, { force: opts.forceWorktree });
  if (!claim.ok) {
    return {
      shadowPath,
      claim,
      error: `worktree claimed by ${formatWorktreeHolder(claim.claim)} — wait or force-override`,
    };
  }
  const akkCfg = readAkkConfig(repoPath);
  if (!akkCfg?.repo) {
    return { shadowPath, claim, error: `missing .akk/config.json repo name in ${repoPath}` };
  }

  if (!existsSync(path.join(shadowPath, ".akk", "config.json"))) {
    rmSync(shadowPath, { recursive: true, force: true });
    const cl = await runAkk(["clone", akkCfg.repo, shadowPath], path.dirname(shadowPath));
    if (!cl.ok) return { shadowPath, claim, error: `akk clone: ${cl.err || cl.out}` };
  }
  const co = await runAkk(["checkout", ref], shadowPath);
  if (!co.ok) return { shadowPath, claim, error: `akk checkout ${ref}: ${co.err || co.out}` };

  // Symlink node_modules + profile extras (.venv) from source repo.
  for (const rel of ["node_modules", ...detectRepoProfile(repoPath).shadowLinks]) {
    const src = path.join(repoPath, rel);
    if (!existsSync(src)) continue;
    const dst = path.join(shadowPath, rel);
    try {
      const st = lstatSync(dst);
      if (st.isSymbolicLink()) unlinkSync(dst);
      else rmSync(dst, { recursive: true, force: true });
    } catch {
      /* nothing there */
    }
    symlinkSync(src, dst);
  }
  return { shadowPath, claim, error: null };
}

/**
 * Build a `Pipeline` snapshot for an `akk` repo (`trunk → stage → prod` using trunk +
 * S3 markers / `current-stage` & `current-prod` tags). Auto-pulls the workspace when
 * clean and `cfg.autoRebase` is enabled.
 */
export async function computeAkkPipeline(
  cfg: WatchConfig,
): Promise<{ pipeline: Pipeline | null; error: string | null; synced: LocalSync[] }> {
  const { repoPath } = cfg;
  const synced: LocalSync[] = [];
  const [stR, tagsR, logR] = await Promise.all([
    runAkk(["status"], repoPath),
    runAkk(["tags"], repoPath),
    runAkk(["log", "-n", "50", "trunk"], repoPath),
  ]);

  if (!stR.ok) {
    return { pipeline: null, error: stR.err || "akk status failed", synced };
  }
  const status = parseAkkStatus(stR.out);
  if (!status) {
    return { pipeline: null, error: "could not parse akk status", synced };
  }

  // Pull clean workspace forward when behind trunk (equivalent of autoRebase for akk).
  if (cfg.autoRebase && status.behind && status.changes.length === 0 && status.trunk) {
    const pullR = await runAkk(["pull"], repoPath);
    if (pullR.ok) {
      synced.push({
        branch: "trunk",
        behind: 1,
        toShort: status.trunk.slice(0, 7),
        originSha: status.trunk,
        ok: true,
        blocked: false,
      });
    } else {
      synced.push({
        branch: "trunk",
        behind: 1,
        toShort: status.trunk.slice(0, 7),
        originSha: status.trunk,
        ok: false,
        blocked: true,
        reason: pullR.err || "akk pull failed",
      });
    }
  }

  const commits = logR.ok ? parseAkkLog(logR.out) : [];
  const tags = tagsR.ok ? parseAkkTags(tagsR.out) : new Map<string, string>();
  const akkCfg = readAkkConfig(repoPath);
  const trunkTip = (status.trunk || akkCfg?.base || commits[0]?.sha || "").toLowerCase();

  const findCommit = (sha: string): Commit | null => {
    if (!sha) return null;
    const low = sha.toLowerCase();
    return (
      commits.find((c) => c.sha === low || c.sha.startsWith(low) || low.startsWith(c.sha)) ?? null
    );
  };

  const lanes: Lane[] = [];
  if (trunkTip) {
    lanes.push({
      name: cfg.branches[0] ?? "trunk",
      tip: trunkTip,
      short: trunkTip.slice(0, 7),
      commit: findCommit(trunkTip),
      ci: "none",
    });
  }
  const stageTip = (cfg.stageDeployedSha ?? tags.get("current-stage") ?? "").toLowerCase();
  if (stageTip) {
    lanes.push({
      name: "stage",
      tip: stageTip,
      short: stageTip.slice(0, 7),
      commit: findCommit(stageTip),
      ci: "none",
    });
  }
  const prodTip = (cfg.prodDeployedSha ?? tags.get("current-prod") ?? "").toLowerCase();
  if (prodTip) {
    lanes.push({
      name: "prod",
      tip: prodTip,
      short: prodTip.slice(0, 7),
      commit: findCommit(prodTip),
      ci: "none",
    });
  }

  const indexOfTip = (sha: string): number => {
    const low = sha.toLowerCase();
    return commits.findIndex(
      (c) => c.sha === low || c.sha.startsWith(low) || low.startsWith(c.sha),
    );
  };

  const gaps: Gap[] = [];
  for (let i = 0; i < lanes.length - 1; i++) {
    const fromLane = lanes[i];
    const toLane = lanes[i + 1];
    const fromIdx = indexOfTip(fromLane.tip);
    const toIdx = indexOfTip(toLane.tip);
    const same =
      fromLane.tip === toLane.tip ||
      fromLane.tip.startsWith(toLane.tip) ||
      toLane.tip.startsWith(fromLane.tip);
    let queued: Commit[] = [];
    let ahead = 0;
    if (!same && fromIdx >= 0 && toIdx > fromIdx) {
      queued = commits.slice(fromIdx, toIdx);
      ahead = queued.length;
    } else if (!same && fromIdx >= 0 && toIdx < 0) {
      queued = commits.slice(fromIdx);
      ahead = queued.length;
    }
    gaps.push({
      from: fromLane.name,
      to: toLane.name,
      ahead,
      behind: 0,
      ff: true,
      queued,
    });
  }

  return {
    pipeline: {
      repoPath,
      remote: `akk:${status.repo}`,
      ghRepo: null,
      lanes,
      gaps,
      incoming: commits.slice(0, 15),
      localBranch: "trunk",
      localCommits: commits.slice(0, 15),
      fetchedAt: Date.now(),
    },
    error: null,
    synced,
  };
}
