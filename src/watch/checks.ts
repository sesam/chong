import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  agentEdit,
  agentGate,
  cherryPickGatePrompt,
  cherryPickResolvePrompt,
  findAgentBin,
  i18nGatePrompt,
  i18nResolvePrompt,
  lintGatePrompt,
  lintResolvePrompt,
} from "./agent";
import {
  type EslintError,
  formatLintSummary,
  lintableChangedFiles,
  runEslint,
} from "./lint";
import { filterDepsByReleasePolicy, readDepsPolicy } from "./deps-policy";
import { fetchDismissedPackageNames, parseGitHubSlug } from "./gh";
import {
  acquireWorktreeClaim,
  formatWorktreeHolder,
  type WorktreeAcquireResult,
} from "./worktree-claim";
import {
  type Untranslated,
  addedLineNumbers,
  findUntranslated,
  isDisplayFile,
  isExcludedPath,
  isScannable,
} from "./i18n-scan";
import { repo } from "./repo";

type Run = { ok: boolean; out: string; err: string };

async function spawnCapture(cmd: string[], cwd: string): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out, err };
}

async function git(args: string[], cwd: string): Promise<Run> {
  const r = await spawnCapture(["git", ...args], cwd);
  return { ok: r.ok, out: r.out.trim(), err: r.err.trim() };
}

/**
 * Like {@link git} but keeps stdout byte-exact. Required for `-z` output: a path may
 * legitimately begin or end with whitespace, which {@link git}'s `.trim()` would eat
 * off the first/last NUL-separated field.
 */
async function gitZ(args: string[], cwd: string): Promise<Run> {
  const r = await spawnCapture(["git", ...args], cwd);
  return { ok: r.ok, out: r.out, err: r.err.trim() };
}

async function sh(cmd: string[], cwd: string): Promise<Run> {
  const r = await spawnCapture(cmd, cwd);
  return { ok: r.ok, out: r.out.trim(), err: r.err.trim() };
}

/**
 * Paths from `git status --porcelain -z`.
 *
 * `--porcelain` without `-z` *quotes* any path with a space, a quote or a non-ASCII
 * byte (`"a b.txt"`, `"\304\215.txt"`). Every site below compares those strings
 * against `git diff-tree` output and then feeds them back to `git checkout --` /
 * `git add --`, where the quoted spelling matches nothing — so the file was silently
 * neither reverted nor staged, and a later `git add -A` swept it into an unrelated
 * auto-fix commit. `-z` emits each path verbatim, NUL-terminated, and never quotes.
 *
 * Rename/copy entries (`R…`/`C…`) emit *two* NUL-terminated fields: the destination
 * (in the entry) followed by the source path on its own. The source is consumed so it
 * is not mistaken for a further entry.
 */
type StatusEntryZ = { status: string; path: string };

/**
 * Same NUL-separated parsing {@link parseStatusZ} does, but keeps the 2-letter status
 * code so callers can tell an untracked ("??") entry from a modified tracked one — needed
 * to refuse an auto-commit when the tree has untracked files a step did not expect (a
 * leftover from a previous step, or a scratch file/directory an agent run left behind)
 * instead of silently sweeping them in with `git add -A`.
 */
function parseStatusEntriesZ(out: string): StatusEntryZ[] {
  const fields = out.split("\0").filter((f) => f.length > 0);
  const entries: StatusEntryZ[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const status = entry.slice(0, 2);
    // "XY PATH" — two status letters, one space, then the path verbatim.
    entries.push({ status, path: entry.slice(3) });
    if (/[RC]/.test(status)) i++;
  }
  return entries;
}

export function parseStatusZ(out: string): string[] {
  return parseStatusEntriesZ(out).map((e) => e.path);
}

/** Changed paths in `cwd`'s working tree + index, unquoted. See {@link parseStatusZ}. */
async function statusPaths(cwd: string): Promise<string[]> {
  const r = await gitZ(["status", "--porcelain", "-z"], cwd);
  return parseStatusZ(r.out);
}

/** Untracked ("??") paths only, unquoted. See {@link parseStatusEntriesZ}. */
async function untrackedStatusPaths(cwd: string): Promise<string[]> {
  const r = await gitZ(["status", "--porcelain", "-z"], cwd);
  return parseStatusEntriesZ(r.out)
    .filter((e) => e.status === "??")
    .map((e) => e.path);
}

/**
 * Untracked ("??") paths in `cwd` that a step did NOT expect — used by every auto-commit
 * site below to refuse the commit instead of silently sweeping such files in with
 * `git add -A` (a scratch file/directory an agent run left behind; leftover output from
 * a previous step). `isExpected` is either an explicit allowlist (eslint's `files`, or a
 * step's own before/after-diffed touched paths) or a predicate for open-ended scope
 * (i18n's ".po"/".pot" allowance). Empty result ⇒ safe to stage the expected paths and
 * commit.
 */
export async function unexpectedUntracked(
  cwd: string,
  isExpected: ReadonlySet<string> | ReadonlyArray<string> | ((path: string) => boolean),
): Promise<string[]> {
  const untracked = await untrackedStatusPaths(cwd);
  const test =
    typeof isExpected === "function"
      ? isExpected
      : (() => {
          const set = isExpected instanceof Set ? isExpected : new Set(isExpected);
          return (p: string) => set.has(p);
        })();
  return untracked.filter((p) => !test(p));
}

/** NUL-separated paths (`ls-files -z`, `diff-tree -z`, …), unquoted. */
export function splitNulPaths(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

// Built via RegExp so the ESC control char isn't a literal in a regex (biome rule).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

async function commitFiles(repoPath: string, sha: string): Promise<string[]> {
  // `-z`: `--name-only` otherwise quotes non-ASCII / space-bearing paths, which then
  // fail to match the (unquoted) `git status` paths these are intersected with.
  const r = await gitZ(["diff-tree", "--no-commit-id", "-r", "-z", "--name-only", sha], repoPath);
  return r.ok ? splitNulPaths(r.out) : [];
}

/**
 * For a `.po`/`.pot` file left dirty by `pnpm i18n`, decide whether the diff is
 * genuine translation work (added/removed `msgid`/`msgstr`/`msgctxt` or string
 * continuation lines) rather than only auto-regenerated comment churn — the
 * `#. Context:` / `#: file` reference comments the extractor rewrites without
 * touching any actual entry. Non-PO files can't be classified this way, so
 * they're conservatively treated as meaningful.
 */
async function hasMeaningfulI18nChange(file: string, cwd: string): Promise<boolean> {
  if (!file.endsWith(".po") && !file.endsWith(".pot")) return true;
  const d = await git(["diff", "--no-color", "-U0", "--", file], cwd);
  if (!d.ok) return true; // can't read the diff → don't suppress the warning
  for (const l of d.out.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l[0] !== "+" && l[0] !== "-") continue;
    const body = l.slice(1).trimStart();
    if (
      body.startsWith("msgid") ||
      body.startsWith("msgstr") ||
      body.startsWith("msgctxt") ||
      body.startsWith('"')
    ) {
      return true;
    }
  }
  return false;
}

export type I18nCheck = {
  hasPo: boolean;
  hasI18nCode: boolean;
  mismatch: boolean;
};

/**
 * True when an added diff line looks like an i18n code change (so a paired
 * .po/.pot update is expected). Deliberately rejects identifiers that merely
 * *end* in `t(` — `it('…')`, `import('…')`, `.get("…")`, `split('…')`,
 * `test('…')`, `format('…')` — which used to light the watch mismatch warning
 * on every Vitest / dynamic-import commit.
 *
 * Matches: bare `t('…')` / `t("…")` / `t(\`…\`)`, `$t('…')`, `useT`, word `i18n`.
 */
export function addedLineLooksLikeI18nCode(line: string): boolean {
  return /\bi18n\b|\buseT\b|(?<![A-Za-z0-9_])t\(['"`]/.test(line);
}

export async function checkI18n(repoPath: string, sha: string): Promise<I18nCheck> {
  const [files, showR] = await Promise.all([
    commitFiles(repoPath, sha),
    git(["show", "--format=", "-U0", sha], repoPath),
  ]);
  const hasPo = files.some((f) => f.endsWith(".po") || f.endsWith(".pot"));
  const hasI18nCode =
    showR.ok &&
    showR.out
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .some((l) => addedLineLooksLikeI18nCode(l));
  return { hasPo, hasI18nCode, mismatch: hasPo !== hasI18nCode };
}

export type FileFindings = {
  file: string;
  findings: Untranslated[];
  display: boolean; // true for .vue / JSX / UI-rendering files (user-facing, prioritised)
};

/**
 * Scan only the lines a commit *added* for hardcoded strings not wrapped in `t()`.
 * Scopes to the commit's diff (so pre-existing strings aren't re-flagged) and is
 * cheap enough to run on every new incoming commit. Returns one entry per file that
 * has new untranslated strings.
 */
export async function scanCommitForUntranslated(
  repoPath: string,
  sha: string,
): Promise<FileFindings[]> {
  const diffR = await git(["show", sha, "--format=", "-U0"], repoPath);
  if (!diffR.ok) return [];
  const added = addedLineNumbers(diffR.out);
  const results: FileFindings[] = [];
  for (const [file, lines] of added) {
    if (!isScannable(file) || isExcludedPath(file)) continue;
    const show = await git(["show", `${sha}:${file}`], repoPath);
    if (!show.ok) continue; // file deleted/renamed-away at this sha
    const findings = findUntranslated(show.out, file).filter((f) => lines.has(f.line));
    if (findings.length) results.push({ file, findings, display: isDisplayFile(file, show.out) });
  }
  return results;
}

/**
 * Full-tree scan for hardcoded strings not wrapped in `t()`, across all tracked
 * source files. Used by the manual maintenance pass to audit the whole repo.
 */
export async function scanRepoForUntranslated(
  repoPath: string,
  pathspec?: string,
  includeExcluded = false,
): Promise<FileFindings[]> {
  // `-z` so non-ASCII paths arrive verbatim rather than as `"\304\215.vue"`, which
  // would then fail to open and be silently skipped from the scan.
  const lsArgs = pathspec ? ["ls-files", "-z", "--", pathspec] : ["ls-files", "-z"];
  const ls = await gitZ(lsArgs, repoPath);
  if (!ls.ok) return [];
  const files = splitNulPaths(ls.out).filter(
    (f) => isScannable(f) && (includeExcluded || !isExcludedPath(f)),
  );
  const results: FileFindings[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await Bun.file(path.join(repoPath, file)).text();
    } catch {
      continue;
    }
    const findings = findUntranslated(content, file);
    if (findings.length) results.push({ file, findings, display: isDisplayFile(file, content) });
  }
  return results;
}

/** Skip auto-fix commits generated by chong itself to avoid re-checking them. */
export async function isAutoFix(repoPath: string, sha: string): Promise<boolean> {
  const r = await git(["log", "-1", "--format=%s", sha], repoPath);
  return r.ok && (r.out.startsWith("FIX:") || r.out.startsWith("CLEAN:"));
}

/** Subject of the current HEAD commit in `cwd` (empty string on failure). */
async function headSubject(cwd: string): Promise<string> {
  const r = await git(["log", "-1", "--format=%s"], cwd);
  return r.ok ? r.out.trim() : "";
}

/**
 * True when a commit with this exact subject already appears among the last `n`
 * commits in `cwd`. Used to detect an auto-fix oscillating (e.g. a formatter that
 * flip-flops between two outputs on a file with real unresolved conflict markers)
 * instead of making forward progress — a plain "is HEAD already the fix?" check
 * misses that case because each oscillation *does* produce a real diff.
 */
async function subjectRepeatsRecently(cwd: string, subject: string, n = 10): Promise<boolean> {
  const r = await git(["log", `-${n}`, "--format=%s"], cwd);
  if (!r.ok) return false;
  return r.out.split("\n").includes(subject);
}

/**
 * Per-repo+branch persisted flag directory for auto-fix loop guards. Deliberately
 * outside the shadow worktree (which can be recreated/reset) and outside the repo
 * itself (nothing to accidentally commit) — under `~/.chong/state/`, alongside the
 * shadow-worktree cache in `~/.chong/worktrees/`.
 */
function autoFixBlockerPath(repoPath: string, branch: string, kind: string): string {
  const base = path.basename(repoPath);
  const hash = createHash("sha1").update(repoPath).digest("hex").slice(0, 8);
  return path.join(homedir(), ".chong", "state", `${base}-${hash}-${branch}-${kind}.block`);
}

/**
 * Reads a durable "stop retrying" flag for a repo+branch+kind (e.g. "codestyle").
 * Unlike the in-memory `i18nPausedUntil` cooldown, this survives process restarts:
 * once `subjectRepeatsRecently` catches a real oscillation, retrying on the next
 * poll would just burn another push, so we require a human to delete the file
 * after fixing the underlying cause.
 */
async function autoFixBlockReason(
  repoPath: string,
  branch: string,
  kind: string,
): Promise<string | null> {
  const p = autoFixBlockerPath(repoPath, branch, kind);
  if (!existsSync(p)) return null;
  try {
    return (await Bun.file(p).text()).trim() || "blocked";
  } catch {
    return "blocked";
  }
}

async function setAutoFixBlocker(
  repoPath: string,
  branch: string,
  kind: string,
  reason: string,
): Promise<void> {
  const p = autoFixBlockerPath(repoPath, branch, kind);
  mkdirSync(path.dirname(p), { recursive: true });
  await Bun.write(
    p,
    `${new Date().toISOString()} ${reason}\nDelete this file once the underlying cause is fixed to re-enable auto-fix.\n`,
  );
}

export type ShadowInfo = {
  shadowPath: string;
  error: string | null;
  /**
   * Outcome of the mandatory claim acquire. Surfaced instead of swallowed so a caller
   * that holds a long-lived view of ownership (`chong watch`) learns that *this* call
   * took the claim — otherwise the operator was told "no worktree ownership" while the
   * process demonstrably held it, and every claim-gated action stayed disabled.
   */
  claim: WorktreeAcquireResult;
  /**
   * Non-fatal problems worth telling the operator about (e.g. a legacy worktree left
   * in place because it had local work in it). Callers should de-duplicate: the same
   * warning recurs on every call until the cause is dealt with by hand.
   */
  warnings?: string[];
};

/**
 * Who owns the shadow worktree for the duration of this call.
 *
 * `processId` is deliberately **required**, and so is this whole options argument.
 * `ensureShadow` runs `cherry-pick --abort`, `clean -fd` and `reset --hard` on a
 * worktree several processes share; the claim is the only thing standing between that
 * and another process's in-flight deploy or agent edit. While the claim was opt-in
 * (`if (opts.processId)`), merely *forgetting* the argument was a silent, total bypass
 * — and three callers had forgotten it. Making it mandatory moves that mistake from
 * "destroys someone's work at runtime" to "does not compile". There is no unclaimed
 * escape hatch because there is no read-only use of this function: every path below
 * mutates the worktree.
 */
export type ShadowClaimOpts = {
  /** Stable per-process id; the same one used for deploy claims. */
  processId: string;
  /** Operator override: take the claim even from a live foreign holder. */
  forceWorktree?: boolean;
};

/**
 * Where chong keeps a repo's main-shadow worktree: under ~/.chong/worktrees/ rather
 * than as a sibling of the repo, so unrelated tooling (and the user) never trip over
 * it. Keyed by repo basename + a short hash of the absolute top-level path, so two
 * checkouts that share a basename get distinct shadow worktrees.
 */
export function shadowPathFor(repoPath: string): string {
  const base = path.basename(repoPath);
  const hash = createHash("sha1").update(repoPath).digest("hex").slice(0, 8);
  return path.join(homedir(), ".chong", "worktrees", `${base}-main-shadow-${hash}`);
}

/**
 * Ensure the main-shadow worktree exists and is hard-reset to `ref`.
 *
 * Requires a worktree claim — see {@link ShadowClaimOpts} for why that is mandatory
 * rather than optional.
 */
export async function ensureShadow(
  repoPath: string,
  ref: string,
  opts: ShadowClaimOpts,
): Promise<ShadowInfo> {
  const shadowPath = shadowPathFor(repoPath);
  mkdirSync(path.dirname(shadowPath), { recursive: true });
  const warnings: string[] = [];

  const claim = acquireWorktreeClaim(shadowPath, opts.processId, {
    force: opts.forceWorktree,
  });
  if (!claim.ok) {
    return {
      shadowPath,
      claim,
      error: `worktree claimed by ${formatWorktreeHolder(claim.claim)} — wait or force-override`,
    };
  }
  const done = (error: string | null): ShadowInfo => ({
    shadowPath,
    claim,
    error,
    ...(warnings.length ? { warnings } : {}),
  });

  // Prune stale worktree entries first
  await git(["worktree", "prune"], repoPath);

  // Migrate away from the old sibling location (../main-shadow), if one is still
  // registered, so we don't leave an orphaned worktree behind.
  //
  // Only when it is safe to: `worktree remove --force` on a path match alone also
  // discards modified and untracked files, and `<repo parent>/main-shadow` is a name a
  // user could plausibly have given a worktree of their own. So require both an empty
  // `git status` (nothing to lose) and a detached HEAD (the shape *we* create — a
  // worktree on a real branch is somebody's working copy, not our leftover). Otherwise
  // warn and leave it alone; an orphaned registration is harmless next to lost work.
  const legacyPath = path.join(path.dirname(repoPath), "main-shadow");
  if (legacyPath !== shadowPath) {
    const reg = await git(["worktree", "list", "--porcelain"], repoPath);
    const legacyLinked = reg.out
      .split("\n")
      .some((l) => l.startsWith("worktree ") && l.slice("worktree ".length).trim() === legacyPath);
    if (legacyLinked) {
      const dirty = await statusPaths(legacyPath);
      const branchR = await git(["symbolic-ref", "--quiet", "HEAD"], legacyPath);
      const detached = !branchR.ok;
      if (dirty.length > 0 || !detached) {
        warnings.push(
          `legacy worktree ${legacyPath} left in place — ${
            dirty.length > 0 ? `${dirty.length} uncommitted change(s)` : `on branch ${branchR.out}`
          }; remove it by hand once you've saved anything you need`,
        );
      } else {
        await git(["worktree", "remove", legacyPath], repoPath);
      }
    }
  }

  const listR = await git(["worktree", "list", "--porcelain"], repoPath);
  const linked = listR.out
    .split("\n")
    .some((l) => l.startsWith("worktree ") && l.slice("worktree ".length).trim() === shadowPath);

  if (!linked) {
    const addR = await git(["worktree", "add", "--detach", shadowPath, ref], repoPath);
    if (!addR.ok) return done(`worktree add: ${addR.err}`);
  } else {
    // Remove stale index.lock before touching the worktree
    const gitDirR = await git(["rev-parse", "--git-dir"], shadowPath);
    if (gitDirR.ok) {
      const lock = path.join(gitDirR.out, "index.lock");
      try {
        unlinkSync(lock);
      } catch {
        /* doesn't exist, fine */
      }
    }

    // Clear any leftover cherry-pick/rebase/merge state before hard-reset.
    await git(["cherry-pick", "--abort"], shadowPath);
    await git(["rebase", "--abort"], shadowPath);
    await git(["merge", "--abort"], shadowPath);
    await git(["clean", "-fd"], shadowPath);
    const resetR = await git(["reset", "--hard", ref], shadowPath);
    if (!resetR.ok) return done(`reset to ${ref}: ${resetR.err}`);
  }

  // Symlink node_modules from the source repo — same lockfile, avoids pnpm hoisting
  // differences and is much faster than a fresh install. Clear any existing entry
  // (real dir or stale/dangling symlink) with lstat so we don't follow the link.
  const nmSource = path.join(repoPath, "node_modules");
  const nmLink = path.join(shadowPath, "node_modules");
  try {
    const stat = lstatSync(nmLink);
    if (stat.isSymbolicLink()) unlinkSync(nmLink);
    else rmSync(nmLink, { recursive: true, force: true });
  } catch {
    /* nothing there yet */
  }
  symlinkSync(nmSource, nmLink);

  return done(null);
}

const MAX_INJECT = 30; // refuse runaway cherry-pick batches
export const I18N_PAUSE_MS = 2 * 60 * 60 * 1000; // 2h pause after uncertain i18n agent verdict
export const AUTO_MAINT_EVERY_COMMITS = 20;
export const AUTO_MAINT_EVERY_MS = 2 * 60 * 60 * 1000; // 2h
/**
 * A local head-lane commit must be at least this old before `reconcileLocalMain` will
 * push or cherry-pick it onto origin. Without this, chong can push a commit within one
 * poll (~15s), and `git commit --amend` / a rebase right after that is unsafe: the
 * original is already on origin, so `git cherry` sees the amended commit as a new,
 * unique patch and cherry-picks it on top — a conflict or duplicated content until the
 * patch-id block-list catches it. This buys a short window to amend before that happens.
 */
export const INJECT_GRACE_MS = 30 * 1000; // 30s

/** Milliseconds since `sha` was committed in `cwd`, or null if it can't be read. */
async function commitAgeMs(cwd: string, sha: string): Promise<number | null> {
  const r = await git(["log", "-1", "--format=%ct", sha], cwd);
  const sec = Number.parseInt(r.out, 10);
  return r.ok && Number.isFinite(sec) ? Date.now() - sec * 1000 : null;
}

/**
 * True when a cherry-pick onto a diverged tip preserved the source patch-id.
 * Partial applies (some hunks already upstream) change the patch-id and must
 * not be pushed — otherwise `git cherry` still lists the local SHA as unique
 * and the next poll re-injects forever.
 */
export function cherryPickPatchPreserved(
  sourceId: string | null,
  headId: string | null,
): boolean {
  return !!sourceId && !!headId && sourceId === headId;
}

/** True when a cherry-pick is still in progress in `cwd`. */
async function cherryPickInProgress(cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], cwd);
  if (!r.ok || !r.out) return false;
  const p = path.isAbsolute(r.out) ? r.out : path.join(cwd, r.out);
  try {
    return (await Bun.file(p).exists()) === true;
  } catch {
    return false;
  }
}

/** True when any tracked file still has conflict markers. */
async function hasConflictMarkers(cwd: string): Promise<boolean> {
  const r = await git(["diff", "--check"], cwd);
  // `--check` exits 2 when conflict markers are present; also scan stderr/stdout.
  const blob = `${r.out}\n${r.err}`;
  return /^(?:.*:)?\d+: leftover conflict marker/m.test(blob) || /<<<<<<</.test(blob);
}

/**
 * Ask the coding agent whether a conflicted cherry-pick is safe, and if so
 * have it finish the cherry-pick. Returns ok=true only when the worktree no
 * longer has an in-progress cherry-pick and no conflict markers.
 */
export async function resolveCherryPickWithAgent(
  shadowPath: string,
  sha: string,
): Promise<{ ok: boolean; message: string }> {
  if (!findAgentBin()) {
    return { ok: false, message: "no agent on PATH — cannot auto-resolve" };
  }
  const short = sha.slice(0, 7);
  const gate = await agentGate(shadowPath, cherryPickGatePrompt(short));
  if (gate.verdict !== "SAFE") {
    return {
      ok: false,
      message: `agent ${gate.verdict.toLowerCase()} on ${short}${gate.text ? `: ${gate.text.split("\n").pop()}` : ""}`,
    };
  }

  const edit = await agentEdit(shadowPath, cherryPickResolvePrompt(short));
  if (!edit.ok) {
    return { ok: false, message: `agent resolve failed: ${edit.text.slice(0, 200)}` };
  }

  // If the agent left the cherry-pick mid-continue, try once more ourselves.
  if (await cherryPickInProgress(shadowPath)) {
    const cont = await git(["-c", "core.editor=true", "cherry-pick", "--continue"], shadowPath);
    if (!cont.ok && (await cherryPickInProgress(shadowPath))) {
      return {
        ok: false,
        message: `agent left cherry-pick incomplete (${cont.err || cont.out})`.slice(0, 200),
      };
    }
  }

  if (await hasConflictMarkers(shadowPath)) {
    return { ok: false, message: "conflict markers remain after agent resolve" };
  }
  if (await cherryPickInProgress(shadowPath)) {
    return { ok: false, message: "cherry-pick still in progress after agent resolve" };
  }
  return { ok: true, message: `agent resolved cherry-pick ${short}` };
}

export type ReconcileResult = {
  /** What happened. */
  action: "noop" | "pushed" | "cherry-picked" | "conflict" | "error" | "skipped";
  /** How many local-only (non-equivalent) commits were considered. */
  count: number;
  /** True when origin/<branch> advanced. */
  pushed: boolean;
  /** Short human-readable summary for the TUI notice line. */
  message: string;
  /** Local branch tip SHA when reconcile ran (for inject blocklist scoping). */
  localTip?: string;
  /**
   * Local SHAs that must not be auto-injected again until the local tip moves.
   * Set when a cherry-pick would re-apply a *different* patch (partial apply) —
   * re-trying those forever is what flooded origin/main with duplicate HTML hunks.
   */
  blockShas?: string[];
};

export type ReconcileOpts = {
  /**
   * Worktree claim id, required for the same reason {@link ShadowClaimOpts} requires
   * one: the diverged branch of this function resets main-shadow to the origin tip
   * before replaying commits onto it. This type used to carry no claim field at all,
   * so the `ensureShadow` call below ran unclaimed — and `maybeReconcileLocalMain`
   * fires it on every poll cycle, which meant any watch reset the shared worktree the
   * moment its local `main` diverged, deploy in flight or not.
   */
  processId: string;
  /** Try cursor-agent (Auto) on cherry-pick conflicts (default true when bin present). */
  agentResolve?: boolean;
  /** Local SHAs previously blocked for this local tip (patch-id mismatch / empty). */
  skipShas?: ReadonlySet<string>;
  /**
   * Master switch for auto-injecting local-only head-lane commits onto origin — both the
   * fast-forward push and the diverged cherry-pick+push path. Default true (unchanged
   * behaviour); `--no-auto-inject` sets this false so chong never pushes a commit the
   * operator hasn't explicitly promoted, e.g. while they still might amend it.
   */
  autoInject?: boolean;
};

/**
 * Land commits that exist on the local head-lane branch (e.g. `main`) but not on
 * `origin/main` — including the diverged case where origin has moved ahead too.
 *
 *  - origin is ancestor of local → plain push
 *  - diverged → reset main-shadow to origin, cherry-pick local-only commits
 *    (skipping patches `git cherry` already sees on origin), push if clean
 *  - conflict → optional agent resolve; else abort, leave origin untouched
 *  - partial cherry-pick (patch-id changes) → abort + block those SHAs; never push
 *
 * Does not promote to stage/prod — that stays a manual `[s]`/`[p]` action.
 */
export async function reconcileLocalMain(
  repoPath: string,
  remote: string,
  branch: string,
  opts: ReconcileOpts,
): Promise<ReconcileResult> {
  const agentResolve = opts.agentResolve !== false && !!findAgentBin();
  const skipShas = opts.skipShas;

  const localSha = await repo.localSha(repoPath, branch);
  if (!localSha) return { action: "noop", count: 0, pushed: false, message: `no local ${branch}` };

  const tip = (r: Omit<ReconcileResult, "localTip">): ReconcileResult => ({
    ...r,
    localTip: localSha,
  });
  const noop = (message: string, count = 0): ReconcileResult =>
    tip({ action: "noop", count, pushed: false, message });

  if (opts.autoInject === false) return noop("auto-inject disabled (--no-auto-inject)");

  const originRef = `${remote}/${branch}`;
  const originSha = await repo.tip(repoPath, remote, branch);
  if (!originSha) return noop(`no ${originRef}`);
  if (localSha === originSha) return noop("in sync");

  // Only commits whose patches aren't already on origin (handles prior cherry-picks).
  let unique = await repo.uniqueCommits(repoPath, originRef, branch);
  if (skipShas?.size) {
    unique = unique.filter((sha) => !skipShas.has(sha));
  }

  // Hold back commits still inside the grace window (see INJECT_GRACE_MS). `unique` is
  // oldest-first (git cherry order), so once we hit the first commit that hasn't cleared
  // the window, it and everything after it (all newer) are withheld together — never
  // inject "around" a commit that might still get amended.
  let heldBack = 0;
  for (let i = 0; i < unique.length; i++) {
    const age = await commitAgeMs(repoPath, unique[i]);
    if (age !== null && age < INJECT_GRACE_MS) {
      heldBack = unique.length - i;
      unique = unique.slice(0, i);
      break;
    }
  }

  if (unique.length === 0) {
    return noop(
      heldBack > 0
        ? `${heldBack} local ${branch} commit(s) within ${Math.round(INJECT_GRACE_MS / 1000)}s grace window — waiting to inject`
        : "no unique local commits",
    );
  }

  if (unique.length > MAX_INJECT) {
    return tip({
      action: "skipped",
      count: unique.length,
      pushed: false,
      message: `${unique.length} local ${branch} commit(s) exceed auto-inject limit (${MAX_INJECT})`,
    });
  }

  // Skip merge commits — cherry-pick needs -m and is rarely what we want here.
  const toInject: string[] = [];
  for (const sha of unique) {
    if (await repo.isMergeCommit(repoPath, sha)) {
      return tip({
        action: "skipped",
        count: unique.length,
        pushed: false,
        message: `local ${branch} has merge commit ${sha.slice(0, 7)} — inject manually`,
      });
    }
    toInject.push(sha);
  }

  const originIsAncestor = await repo.isAncestor(repoPath, originSha, localSha);

  let pushErr: string | null;
  let action: ReconcileResult["action"];
  let newTip: string | null = null;
  let agentNote = "";

  if (originIsAncestor) {
    // Linear: fast-forward of origin. Push only up through the newest commit that has
    // cleared the grace window above — `toInject`'s last entry, not necessarily
    // `localSha` itself, when the true tip is still too young to push.
    const pushTarget = toInject[toInject.length - 1] ?? localSha;
    pushErr = await repo.pushSha(repoPath, remote, branch, pushTarget);
    action = "pushed";
    if (!pushErr) newTip = pushTarget;
  } else {
    // Diverged: replay local-only commits onto a clean shadow at origin tip.
    const shadow = await ensureShadow(repoPath, originRef, { processId: opts.processId });
    if (shadow.error) {
      return tip({
        action: "error",
        count: toInject.length,
        pushed: false,
        message: `shadow: ${shadow.error}`,
      });
    }
    if (!(await repo.isClean(shadow.shadowPath))) {
      return tip({
        action: "error",
        count: toInject.length,
        pushed: false,
        message: "main-shadow is dirty after reset — refusing to inject",
      });
    }

    const landed: string[] = [];
    const blockShas: string[] = [];

    for (const sha of toInject) {
      const sourceId = await repo.patchId(repoPath, sha);
      const pick = await repo.cherryPick(shadow.shadowPath, sha);

      if (pick.status === "empty") {
        // Patch already present in a different shape — do not keep retrying.
        blockShas.push(sha);
        continue;
      }

      if (pick.status === "error") {
        // Conflict: optionally ask cursor-agent (Auto) to finish if SAFE.
        if (agentResolve) {
          const resolved = await resolveCherryPickWithAgent(shadow.shadowPath, sha);
          if (resolved.ok) {
            // Agent may have composed a different patch — refuse unless patch-id matches.
            const headId = await repo.patchId(shadow.shadowPath, "HEAD");
            if (!cherryPickPatchPreserved(sourceId, headId)) {
              await repo.abortInProgress(shadow.shadowPath);
              await git(["reset", "--hard", originRef], shadow.shadowPath);
              await git(["clean", "-fd"], shadow.shadowPath);
              return tip({
                action: "skipped",
                count: toInject.length,
                pushed: false,
                message: `cherry-pick ${sha.slice(0, 7)} resolved but patch-id changed — refusing to push (would re-inject forever)`,
                blockShas: [...toInject],
              });
            }
            agentNote = ` · ${resolved.message}`;
            landed.push(sha);
            continue;
          }
          agentNote = ` · ${resolved.message}`;
        }

        await repo.abortInProgress(shadow.shadowPath);
        await git(["reset", "--hard", originRef], shadow.shadowPath);
        await git(["clean", "-fd"], shadow.shadowPath);
        return tip({
          action: "conflict",
          count: toInject.length,
          pushed: false,
          message: `cherry-pick ${sha.slice(0, 7)} conflicted — left origin/${branch} untouched${agentNote}`,
        });
      }

      // Clean apply: patch-id must match the source. A *partial* apply (some hunks
      // already on origin, remaining hunks still apply — e.g. re-inserting the same
      // HTML block) produces a new patch-id, so `git cherry` still lists the local
      // SHA as unique and the next poll would inject again → commit flood.
      const headId = await repo.patchId(shadow.shadowPath, "HEAD");
      if (!cherryPickPatchPreserved(sourceId, headId)) {
        await repo.abortInProgress(shadow.shadowPath);
        await git(["reset", "--hard", originRef], shadow.shadowPath);
        await git(["clean", "-fd"], shadow.shadowPath);
        return tip({
          action: "skipped",
          count: toInject.length,
          pushed: false,
          message: `cherry-pick ${sha.slice(0, 7)} changed patch-id (partial apply) — refusing to push`,
          blockShas: [...toInject],
        });
      }
      landed.push(sha);
    }

    if (landed.length === 0) {
      return tip({
        action: "skipped",
        count: toInject.length,
        pushed: false,
        message:
          blockShas.length > 0
            ? `${blockShas.length} local ${branch} commit(s) already on origin in another shape — inject blocked`
            : `nothing to inject onto ${originRef}`,
        blockShas: blockShas.length > 0 ? blockShas : undefined,
      });
    }

    const head = await git(["rev-parse", "HEAD"], shadow.shadowPath);
    pushErr = await repo.pushSha(shadow.shadowPath, remote, branch);
    action = "cherry-picked";
    if (!pushErr && head.ok) newTip = head.out;
  }

  if (pushErr) {
    return tip({
      action: "error",
      count: toInject.length,
      pushed: false,
      message: `push ${branch}: ${pushErr}`,
    });
  }

  // Point the remote-tracking ref at what we just pushed so the next poll's
  // `git cherry` sees the landed patches even if fetch is slow/fails.
  if (newTip) {
    await git(["update-ref", `refs/remotes/${remote}/${branch}`, newTip], repoPath);
  }
  await git(["fetch", "--quiet", remote, branch], repoPath);

  // Backstop: if any injected SHA is still unique after a successful push, block
  // them — otherwise the next refresh() → reconcile loop floods origin.
  if (action === "cherry-picked") {
    const stillUnique = (await repo.uniqueCommits(repoPath, originRef, branch)).filter((sha) =>
      toInject.includes(sha),
    );
    if (stillUnique.length > 0) {
      return tip({
        action: "skipped",
        count: toInject.length,
        pushed: true,
        message: `pushed but ${stillUnique.length} commit(s) still unique by patch-id — blocking re-inject`,
        blockShas: stillUnique,
      });
    }
  }

  const how = action === "pushed" ? "pushed" : "cherry-picked onto origin & pushed";
  return tip({
    action,
    count: toInject.length,
    pushed: true,
    message: `${toInject.length} local ${branch} commit(s) ${how}${agentNote}`,
  });
}

const ESLINT_FIX_SUBJECT = "FIX: eslint";

/**
 * Run eslint --fix in shadow, commit only lintable files from the stage diff, push to main.
 */
export async function runEslintFix(
  repoPath: string,
  shadowPath: string,
  remote: string,
  branch: string,
  from: string,
  to: string,
): Promise<FixResult & { errors?: EslintError[] }> {
  const fromRef = `${remote}/${to}`;
  const toRef = `${remote}/${from}`;
  const scope = await lintableChangedFiles(git, shadowPath, fromRef, toRef);
  if (scope.length === 0) return { committed: false, pushed: false, leftovers: [], error: null };

  await runEslint(shadowPath, scope, true);

  const modified = await statusPaths(shadowPath);
  if (modified.length === 0) {
    const check = await runEslint(shadowPath, scope);
    return {
      committed: false,
      pushed: false,
      leftovers: [],
      error: check.ok ? null : `eslint: ${formatLintSummary(check.errors)}`,
      errors: check.errors,
    };
  }

  const toCommit = scope.filter((f) => modified.includes(f));
  const leftovers = modified.filter((f) => !scope.includes(f));
  const toRevert = leftovers;

  if (toRevert.length > 0) {
    await git(["checkout", "--", ...toRevert], shadowPath);
  }

  if (toCommit.length === 0) {
    const check = await runEslint(shadowPath, scope);
    return {
      committed: false,
      pushed: false,
      leftovers,
      error: check.ok ? null : `eslint: ${formatLintSummary(check.errors)}`,
      errors: check.errors,
    };
  }

  await git(["add", "--", ...toCommit], shadowPath);
  const commitR = await git(["commit", "-m", ESLINT_FIX_SUBJECT, "--no-verify"], shadowPath);
  if (!commitR.ok) {
    return { committed: false, pushed: false, leftovers, error: `commit: ${commitR.err}` };
  }

  const pushR = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
  if (!pushR.ok) {
    return { committed: true, pushed: false, leftovers, error: `push: ${pushR.err}` };
  }

  const head = await git(["rev-parse", "HEAD"], shadowPath);
  if (head.ok) {
    await git(["update-ref", `refs/remotes/${remote}/${branch}`, head.out], repoPath);
  }
  return { committed: true, pushed: true, leftovers, error: null };
}

/** Ask the coding agent to fix agentable eslint errors (e.g. no-undef). */
export async function tryAgentLintFix(
  repoPath: string,
  shadowPath: string,
  summary: string,
  files: string[],
  remote: string,
  branch: string,
): Promise<{ fixed: boolean; message: string }> {
  if (!findAgentBin()) {
    return { fixed: false, message: "no agent on PATH — cannot auto-fix eslint" };
  }

  const gate = await agentGate(shadowPath, lintGatePrompt(summary));
  if (gate.verdict !== "SAFE") {
    return { fixed: false, message: `eslint agent ${gate.verdict.toLowerCase()} — promote blocked` };
  }

  const edit = await agentEdit(shadowPath, lintResolvePrompt(summary));
  if (!edit.ok) {
    return { fixed: false, message: `eslint agent edit failed (${edit.text.slice(0, 120)})` };
  }

  const verify = await runEslint(shadowPath, files);
  if (!verify.ok) {
    await resetShadowDirty(shadowPath);
    return {
      fixed: false,
      message: `eslint still failing after agent (${formatLintSummary(verify.errors).slice(0, 200)})`,
    };
  }

  const changedAfterAgent = await statusPaths(shadowPath);
  if (changedAfterAgent.length === 0) {
    return { fixed: false, message: "eslint agent: nothing to commit" };
  }

  if (await hasConflictMarkers(shadowPath)) {
    await resetShadowDirty(shadowPath);
    return { fixed: false, message: "eslint agent left conflict markers" };
  }

  // Stage only the files the agent was asked to fix. Anything else it touched stays
  // uncommitted here rather than being swept in by `git add -A` — in particular, any
  // scratch file/directory it left behind shows up as untracked, not in `files`, so the
  // next `ensureShadow()` reset discards it instead of it landing on `branch`.
  const unexpectedNew = await unexpectedUntracked(shadowPath, files);
  if (unexpectedNew.length > 0) {
    return {
      fixed: false,
      message: `eslint agent left untracked file(s) outside the fix scope — not committing (${unexpectedNew
        .slice(0, 3)
        .join(", ")}${unexpectedNew.length > 3 ? ", …" : ""})`,
    };
  }

  const toCommit = files.filter((f) => changedAfterAgent.includes(f));
  if (toCommit.length === 0) {
    return { fixed: false, message: "eslint agent: nothing in scope to commit" };
  }

  await git(["add", "--", ...toCommit], shadowPath);
  const commitR = await git(["commit", "-m", "FIX: eslint (agent)", "--no-verify"], shadowPath);
  if (!commitR.ok) {
    return { fixed: false, message: `eslint agent commit failed (${commitR.err})` };
  }

  const pushR = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
  if (!pushR.ok) {
    return { fixed: false, message: `eslint agent committed but push failed (${pushR.err})` };
  }

  const head = await git(["rev-parse", "HEAD"], shadowPath);
  if (head.ok) {
    await git(["update-ref", `refs/remotes/${remote}/${branch}`, head.out], repoPath);
  }
  return { fixed: true, message: `eslint agent fixed → pushed to ${branch}` };
}

export type FixResult = {
  committed: boolean;
  pushed: boolean;
  leftovers: string[];
  error: string | null;
  /** Raw command stdout+stderr when the i18n command failed (for agent prompts). */
  failOutput?: string;
  /** Set when a loop guard suppressed this fix — see `error` for the human-readable reason. */
  blocked?: boolean;
};

/** Discard uncommitted shadow changes so later auto-fixes start clean. */
async function resetShadowDirty(shadowPath: string): Promise<void> {
  await git(["checkout", "--", "."], shadowPath);
  await git(["clean", "-fd"], shadowPath);
}

/**
 * True when `pnpm i18n` failed for empty/identical msgstr (or pointed at the
 * identical-msgstr allowlist) — the mechanical cases cursor-agent should fix.
 */
export function isAgentableI18nFailure(output: string): boolean {
  return /empty msgstr|identical en\/sl msgstr|i18n-identical-msgstr-allowlist/i.test(output);
}

/** Run `pnpm i18n` in shadow, commit .po/.pot changes, push. Returns leftover files. */
export async function runI18nFix(
  repoPath: string,
  shadowPath: string,
  remote: string,
  branch: string,
): Promise<FixResult> {
  const r = await sh(["pnpm", "i18n"], shadowPath);
  if (!r.ok) {
    const failOutput = stripAnsi(`${r.out}\n${r.err}`).trim();
    return {
      committed: false,
      pushed: false,
      leftovers: [],
      error: `pnpm i18n: ${r.err || r.out}`,
      failOutput,
    };
  }

  const changed = await statusPaths(shadowPath);
  if (changed.length === 0) return { committed: false, pushed: false, leftovers: [], error: null };

  const poFiles = changed.filter((f) => f.endsWith(".po") || f.endsWith(".pot"));
  const leftovers = changed.filter((f) => !f.endsWith(".po") && !f.endsWith(".pot"));

  if (poFiles.length === 0) return { committed: false, pushed: false, leftovers, error: null };

  await git(["add", "--", ...poFiles], shadowPath);
  const commitR = await git(["commit", "-m", "FIX: pnpm i18n", "--no-verify"], shadowPath);
  if (!commitR.ok) {
    return { committed: false, pushed: false, leftovers, error: `commit: ${commitR.err}` };
  }

  const pushR = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
  if (!pushR.ok) {
    return { committed: true, pushed: false, leftovers, error: `push: ${pushR.err}` };
  }

  return { committed: true, pushed: true, leftovers, error: null };
}

const FORMAT_FIX_SUBJECT = "FIX: code formatting";
const CODE_STYLE_SUBJECT = "CLEAN: code style";

/**
 * Run the formatter in shadow, commit formatting changes only for files touched by `sha`,
 * revert all other formatter changes, push.
 *
 * Guarded against looping: if a repo+branch already has a durable blocker set (from a
 * previous caught oscillation), this no-ops immediately. Otherwise, before committing,
 * it checks whether `FORMAT_FIX_SUBJECT` already appears in the last 10 commits — if so
 * the formatter is flip-flopping (e.g. a file with real unresolved conflict markers)
 * rather than making progress, so it sets the blocker instead of committing again.
 */
export async function runFormatFix(
  repoPath: string,
  shadowPath: string,
  sha: string,
  formatCmd: string,
  remote: string,
  branch: string,
): Promise<FixResult> {
  const blockReason = await autoFixBlockReason(repoPath, branch, "format");
  if (blockReason) {
    return { committed: false, pushed: false, leftovers: [], error: null, blocked: true };
  }

  const files = await commitFiles(repoPath, sha);
  if (files.length === 0) return { committed: false, pushed: false, leftovers: [], error: null };

  const [cmd, ...cmdArgs] = formatCmd.trim().split(/\s+/);
  await sh([cmd, ...cmdArgs], shadowPath);
  // Ignore exit code — formatters exit 1 when they modify files

  const modified = await statusPaths(shadowPath);
  if (modified.length === 0) return { committed: false, pushed: false, leftovers: [], error: null };

  const toCommit = files.filter((f) => modified.includes(f));
  const toRevert = modified.filter((f) => !files.includes(f));

  // Revert formatting changes on files not part of this commit
  if (toRevert.length > 0) {
    await git(["checkout", "--", ...toRevert], shadowPath);
    await git(["clean", "-fd"], shadowPath);
  }

  if (toCommit.length === 0) return { committed: false, pushed: false, leftovers: [], error: null };

  if (await subjectRepeatsRecently(shadowPath, FORMAT_FIX_SUBJECT)) {
    await setAutoFixBlocker(
      repoPath,
      branch,
      "format",
      `"${FORMAT_FIX_SUBJECT}" already in the last 10 commits but the formatter produced a diff ` +
        `again on ${toCommit.join(", ")} — looks like an oscillation, not forward progress.`,
    );
    await resetShadowDirty(shadowPath);
    return {
      committed: false,
      pushed: false,
      leftovers: [],
      error: `format fix loop detected on ${toCommit.join(", ")} — blocked, see ~/.chong/state/`,
      blocked: true,
    };
  }

  await git(["add", "--", ...toCommit], shadowPath);
  const commitR = await git(["commit", "-m", FORMAT_FIX_SUBJECT, "--no-verify"], shadowPath);
  if (!commitR.ok) {
    return { committed: false, pushed: false, leftovers: [], error: `commit: ${commitR.err}` };
  }

  const pushR = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
  if (!pushR.ok) {
    return { committed: true, pushed: false, leftovers: [], error: `push: ${pushR.err}` };
  }

  return { committed: true, pushed: true, leftovers: [], error: null };
}

const isManifest = (f: string) => f === "package.json" || f.endsWith("/package.json");
const isLockfile = (f: string) => f === "pnpm-lock.yaml" || f.endsWith("/pnpm-lock.yaml");

/**
 * When a commit changes a `package.json` (deps, `overrides`, …) but not the
 * lockfile, CI's `pnpm install --frozen-lockfile` fails with
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. Regenerate the lockfile in shadow
 * (`pnpm install --lockfile-only`, which leaves the symlinked node_modules
 * untouched), commit `FIX: pnpm lockfile`, and push.
 *
 * No-ops when the commit didn't touch a manifest, or already updated the lockfile.
 */
export async function runLockfileFix(
  repoPath: string,
  shadowPath: string,
  sha: string,
  remote: string,
  branch: string,
): Promise<FixResult> {
  const files = await commitFiles(repoPath, sha);
  if (!files.some(isManifest) || files.some(isLockfile)) {
    return { committed: false, pushed: false, leftovers: [], error: null };
  }

  const r = await sh(["pnpm", "install", "--lockfile-only", "--no-frozen-lockfile"], shadowPath);
  if (!r.ok) {
    return {
      committed: false,
      pushed: false,
      leftovers: [],
      error: `pnpm install: ${r.err || r.out}`,
    };
  }

  const changed = await statusPaths(shadowPath);
  if (changed.length === 0) return { committed: false, pushed: false, leftovers: [], error: null };

  const lockFiles = changed.filter(isLockfile);
  const leftovers = changed.filter((f) => !isLockfile(f));

  if (lockFiles.length === 0) return { committed: false, pushed: false, leftovers, error: null };

  await git(["add", "--", ...lockFiles], shadowPath);
  const commitR = await git(["commit", "-m", "FIX: pnpm lockfile", "--no-verify"], shadowPath);
  if (!commitR.ok) {
    return { committed: false, pushed: false, leftovers, error: `commit: ${commitR.err}` };
  }

  const pushR = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
  if (!pushR.ok) {
    return { committed: true, pushed: false, leftovers, error: `push: ${pushR.err}` };
  }

  return { committed: true, pushed: true, leftovers, error: null };
}

// ── maintenance (manual, [m] in the TUI) ─────────────────────────────────────

/** A ready-to-paste prompt for an LLM to fix something maintenance couldn't. */
export type MaintPrompt = { title: string; text: string };

export type MaintResult = {
  steps: string[]; // human-readable log of what each step did, in order
  prompts: MaintPrompt[]; // copy-friendly LLM prompts for whatever isn't perfect
  error: string | null; // a fatal error that aborted the run
  /** When set, watch should skip post-commit i18n auto-fix until this epoch ms. */
  i18nPauseUntil?: number;
  /** True when agent landed an i18n fix commit. */
  i18nAgentFixed?: boolean;
};

export type MaintOpts = {
  /**
   * `commits` — only steps that produce git commits (deps / lockfile / format + FF).
   * `full` — also tests, i18n diagnostics, and optional agent i18n resolve (default).
   */
  mode?: "full" | "commits";
  /** Try cursor-agent on i18n complaints (default true when bin present). */
  agentI18n?: boolean;
};

const major = (v: string) => Number.parseInt(v.replace(/^[^\d]*/, "").split(".")[0] ?? "", 10);

/** Apply same-major bumps one target at a time so one engine/policy failure doesn't abort the batch. */
async function applyMinorDepUpdates(
  shadowPath: string,
  targets: string[],
): Promise<{ updated: string[]; skipped: { target: string; reason: string }[] }> {
  const updated: string[] = [];
  const skipped: { target: string; reason: string }[] = [];
  for (const target of targets) {
    const up = await sh(["pnpm", "update", "--lockfile-only", target], shadowPath);
    if (!up.ok) {
      const reason = tail(`${up.err}\n${up.out}`, 4);
      skipped.push({ target, reason: reason || "pnpm update failed" });
      continue;
    }
    const dirty = (await git(["status", "--porcelain"], shadowPath)).out;
    if (dirty) updated.push(target);
  }
  return { updated, skipped };
}

/** Last `n` non-empty lines of `s`, ANSI-stripped — a compact failure excerpt. */
function tail(s: string, n: number): string {
  const lines = stripAnsi(s)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return lines.slice(-n).join("\n");
}

function compactPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `${parts.slice(0, 1).join("/")}/…/${parts.slice(-2).join("/")}`;
}

/** Unique test-file paths mentioned in runner output (`*.test.ts`, `*.spec.tsx`, …). */
function failingTestFiles(output: string): string[] {
  const re = /[\w./@-]*[\w-]+\.(?:test|spec)\.[cm]?[jt]sx?/g;
  return [...new Set(stripAnsi(output).match(re) ?? [])];
}

/**
 * Ask cursor-agent (Auto) to fix i18n issues described by `summary`.
 * On SAFE + i18n exit 0 + commit → pushes. On UNSAFE/uncertain → cleans + pauseUntil.
 */
export async function tryAgentI18nFix(
  repoPath: string,
  shadowPath: string,
  summary: string,
  i18nCmd: string,
  remote: string,
  branch: string,
): Promise<{
  fixed: boolean;
  paused: boolean;
  pauseUntil?: number;
  message: string;
}> {
  const pause = async (message: string) => {
    await resetShadowDirty(shadowPath);
    const until = Date.now() + I18N_PAUSE_MS;
    return { fixed: false, paused: true, pauseUntil: until, message };
  };

  if (!findAgentBin()) {
    return pause("no agent on PATH — pausing i18n auto-fix 2h");
  }

  const gate = await agentGate(shadowPath, i18nGatePrompt(summary));
  if (gate.verdict !== "SAFE") {
    return pause(`i18n agent ${gate.verdict.toLowerCase()} — pausing auto-fix 2h`);
  }

  const edit = await agentEdit(shadowPath, i18nResolvePrompt(summary, i18nCmd));
  if (!edit.ok) {
    return pause(`i18n agent edit failed — pausing auto-fix 2h (${edit.text.slice(0, 120)})`);
  }

  // Re-run i18n; refuse to commit unless the project check exits 0.
  const [icmd, ...iargs] = i18nCmd.trim().split(/\s+/);
  const verify = await sh([icmd, ...iargs], shadowPath);
  if (!verify.ok) {
    const excerpt = stripAnsi(`${verify.out}\n${verify.err}`).trim().slice(-400);
    return pause(`i18n still failing after agent — pausing auto-fix 2h (${excerpt})`);
  }

  const changed = await statusPaths(shadowPath);
  if (changed.length === 0) {
    return { fixed: false, paused: false, message: "i18n agent: nothing to commit" };
  }

  if (await hasConflictMarkers(shadowPath)) {
    return pause("i18n agent left conflict markers — pausing auto-fix 2h");
  }

  // Stage explicitly rather than `git add -A`. i18n work legitimately creates new .po/.pot
  // files (a fresh feature namespace); anything else untracked is out of scope — most
  // likely a scratch file/directory the agent left behind — so refuse instead of shipping
  // it under this commit's name.
  const unexpectedNew = await unexpectedUntracked(
    shadowPath,
    (f) => f.endsWith(".po") || f.endsWith(".pot"),
  );
  if (unexpectedNew.length > 0) {
    return {
      fixed: false,
      paused: false,
      message: `i18n agent left untracked non-i18n file(s) — not committing (${unexpectedNew
        .slice(0, 3)
        .join(", ")}${unexpectedNew.length > 3 ? ", …" : ""})`,
    };
  }

  await git(["add", "--", ...changed], shadowPath);
  const commitR = await git(["commit", "-m", "FIX: i18n (agent)", "--no-verify"], shadowPath);
  if (!commitR.ok) {
    return pause(`i18n agent commit failed — pausing 2h (${commitR.err})`);
  }

  const pushR = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
  if (!pushR.ok) {
    return {
      fixed: false,
      paused: false,
      message: `i18n agent committed but push failed (${pushR.err})`,
    };
  }
  const head = await git(["rev-parse", "HEAD"], shadowPath);
  if (head.ok) {
    await git(["update-ref", `refs/remotes/${remote}/${branch}`, head.out], repoPath);
  }
  return {
    fixed: true,
    paused: false,
    message: `i18n agent fixed ${changed.length} file(s) → pushed to ${branch}`,
  };
}

/**
 * Maintenance pass in the main-shadow worktree.
 *   1 / 1b / 2 — commit-producing (deps, lockfile, format); push to origin/<branch>
 *   3–5 — diagnostics (tests, i18n, hardcoded scan); skipped when mode=`commits`
 * On i18n complaints (full mode), optionally ask cursor-agent (Auto) to fix when SAFE;
 * otherwise pause post-commit i18n auto-fix for 2h.
 * Does not promote to stage/prod — that stays a manual `[s]`/`[p]` action.
 */
export async function runMaintenance(
  repoPath: string,
  shadowPath: string,
  cmds: { format: string; test: string; i18n: string },
  remote: string,
  branch: string,
  onStep?: (msg: string) => void,
  opts: MaintOpts = {},
): Promise<MaintResult> {
  const mode = opts.mode ?? "full";
  const agentI18n = opts.agentI18n !== false && !!findAgentBin();
  const steps: string[] = [];
  const prompts: MaintPrompt[] = [];
  const step = (msg: string) => {
    steps.push(msg);
    onStep?.(msg);
  };
  let i18nPauseUntil: number | undefined;
  let i18nAgentFixed = false;
  const push = async (): Promise<{ ok: boolean; err: string }> => {
    const pr = await git(["push", remote, `HEAD:refs/heads/${branch}`], shadowPath);
    if (pr.ok) {
      // Keep remote-tracking ref fresh so watch/INCOMING don't look stale mid-run.
      const head = await git(["rev-parse", "HEAD"], shadowPath);
      if (head.ok) {
        await git(["update-ref", `refs/remotes/${remote}/${branch}`, head.out], repoPath);
      }
    }
    return { ok: pr.ok, err: pr.err };
  };

  // ── 1. minor dependency updates
  onStep?.("deps: checking pnpm outdated…");
  const depsPolicy = await readDepsPolicy(shadowPath);
  const outdated = await sh(["pnpm", "outdated", "--format", "json"], shadowPath);
  let targets: string[] = [];
  try {
    const data = JSON.parse(outdated.out || "{}") as Record<
      string,
      { current?: string; latest?: string; wanted?: string }
    >;
    for (const [name, info] of Object.entries(data)) {
      const current = info.current ?? "";
      const latest = info.latest ?? info.wanted ?? "";
      if (!current || !latest || current === latest) continue;
      if (major(current) === major(latest)) targets.push(`${name}@${latest}`);
    }
  } catch {
    targets = [];
  }

  const ghRepoSlug = parseGitHubSlug(await repo.remoteUrl(shadowPath, remote));
  const dismissedPackages = ghRepoSlug
    ? await fetchDismissedPackageNames(ghRepoSlug, shadowPath)
    : new Set<string>();
  const { allowed, blocked } = await filterDepsByReleasePolicy(
    targets,
    depsPolicy,
    dismissedPackages,
  );
  if (blocked.length > 0) {
    const preview = blocked
      .slice(0, 4)
      .map((b) => `${b.target} (${b.reason})`)
      .join("; ");
    step(
      `⏳ deps: skipped ${blocked.length} release(s) blocked by age/vetting policy${preview ? ` — ${preview}` : ""}`,
    );
  }
  targets = allowed;

  if (targets.length === 0) {
    step(
      blocked.length > 0
        ? "✓ deps: no updates passed release policy"
        : "✓ deps: no minor updates available",
    );
  } else {
    // --lockfile-only keeps node_modules (symlinked from the source repo) untouched.
    const { updated, skipped } = await applyMinorDepUpdates(shadowPath, targets);
    if (skipped.length > 0) {
      const preview = skipped
        .slice(0, 3)
        .map((s) => `${s.target} (${s.reason})`)
        .join("; ");
      step(
        `⚠ deps: skipped ${skipped.length} update(s)${preview ? ` — ${preview}` : ""}`,
      );
    }
    const dirty = await statusPaths(shadowPath);
    if (updated.length > 0 && dirty.length > 0) {
      // `pnpm update --lockfile-only` should only ever touch tracked manifests/lockfiles
      // it already knows about — any untracked path here is unexpected (e.g. leftover
      // noise from a prior step), so refuse rather than sweep it into this commit.
      const unexpectedNew = await unexpectedUntracked(shadowPath, []);
      if (unexpectedNew.length > 0) {
        step(
          `⚠ deps: unexpected untracked file(s) — not committing (${unexpectedNew
            .slice(0, 3)
            .join(", ")}${unexpectedNew.length > 3 ? ", …" : ""})`,
        );
      } else {
        await git(["add", "--", ...dirty], shadowPath);
        await git(["commit", "-m", "CLEAN: bump minor deps", "--no-verify"], shadowPath);
        const pr = await push();
        step(
          pr.ok
            ? `✓ deps: updated ${updated.length} package(s) → committed & pushed to ${branch}`
            : `⚠ deps: committed but push failed (${pr.err})`,
        );
      }
    } else if (updated.length === 0 && skipped.length === 0) {
      step("✓ deps: nothing changed");
    } else if (updated.length === 0) {
      step("✓ deps: no updates applied (all targets skipped or unchanged)");
    }
  }

  // ── 1b. reconcile the lockfile with package.json (catches a pre-existing
  // overrides/deps mismatch on origin/main that the post-commit fix never saw,
  // i.e. one that would break CI's `pnpm install --frozen-lockfile`).
  onStep?.("lockfile: reconciling with package.json…");
  const lock = await sh(["pnpm", "install", "--lockfile-only", "--no-frozen-lockfile"], shadowPath);
  if (!lock.ok) {
    step(`⚠ lockfile: pnpm install failed (${lock.err || lock.out})`);
  } else {
    const lockDirty = (await statusPaths(shadowPath)).filter(isLockfile);
    if (lockDirty.length === 0) {
      step("✓ lockfile: in sync with package.json");
    } else {
      await git(["add", "--", ...lockDirty], shadowPath);
      await git(["commit", "-m", "FIX: pnpm lockfile", "--no-verify"], shadowPath);
      const pr = await push();
      step(
        pr.ok
          ? `✓ lockfile: regenerated → committed & pushed to ${branch}`
          : `⚠ lockfile: committed but push failed (${pr.err})`,
      );
    }
  }

  // ── 2. code formatting
  const codestyleBlock = await autoFixBlockReason(repoPath, branch, "codestyle");
  const lastSubject = await headSubject(shadowPath);
  if (codestyleBlock) {
    step(`⏸ code style: blocked — ${codestyleBlock}`);
  } else if (lastSubject === CODE_STYLE_SUBJECT) {
    // The tip is already our own formatting-only commit — running the formatter
    // again here can't fix anything further, and if it's *still* dirty that's the
    // oscillation case caught below, not a fresh issue this cycle.
    step("✓ code style: already clean (last commit was the fix)");
  } else {
    onStep?.("format: running formatter…");
    // Snapshot before running so we can stage only what the formatter itself touched —
    // not e.g. leftover dirt the lockfile step above left uncommitted, which `git add -A`
    // used to sweep in here under the "code style" name.
    const beforeFormat = new Set(await statusPaths(shadowPath));
    const [fcmd, ...fargs] = cmds.format.trim().split(/\s+/);
    await sh([fcmd, ...fargs], shadowPath); // formatters exit non-zero when they rewrite files
    const afterFormat = await statusPaths(shadowPath);
    const fmtTouched = afterFormat.filter((f) => !beforeFormat.has(f));
    if (fmtTouched.length === 0) {
      step("✓ code style: already clean");
    } else if (await subjectRepeatsRecently(shadowPath, CODE_STYLE_SUBJECT)) {
      await setAutoFixBlocker(
        repoPath,
        branch,
        "codestyle",
        `"${CODE_STYLE_SUBJECT}" already in the last 10 commits but the formatter produced a diff again — looks like an oscillation (e.g. a file with real unresolved conflict markers), not forward progress.`,
      );
      await resetShadowDirty(shadowPath);
      step(`⚠ code style: loop detected — blocked, see ~/.chong/state/ (${branch})`);
    } else if ((await unexpectedUntracked(shadowPath, fmtTouched)).length > 0) {
      step("⚠ code style: unexpected untracked file(s) present — not committing");
    } else {
      await git(["add", "--", ...fmtTouched], shadowPath);
      await git(["commit", "-m", CODE_STYLE_SUBJECT, "--no-verify"], shadowPath);
      const pr = await push();
      step(
        pr.ok
          ? `✓ code style: committed & pushed to ${branch}`
          : `⚠ code style: committed but push failed (${pr.err})`,
      );
    }
  }

  if (mode === "commits") {
    return { steps, prompts, error: null };
  }

  // ── 3. unit tests
  onStep?.("test: running unit tests…");
  const [tcmd, ...targs] = cmds.test.trim().split(/\s+/);
  const test = await sh([tcmd, ...targs], shadowPath);
  if (test.ok) {
    step("✓ tests: passing");
  } else {
    const files = failingTestFiles(`${test.out}\n${test.err}`);
    step(`⚠ tests: ${files.length || "some"} failing — see copy prompt below`);
    const cmd =
      files.length > 0
        ? `${cmds.test} ${files.join(" ")}`
        : `${cmds.test} (then re-run only the failing test file(s))`;
    prompts.push({
      title: "fix failing test(s)",
      text: files.length
        ? [
            "Fix the failing unit tests.",
            "",
            "Reproduce (only failing files):",
            cmd,
            "",
            `Failing files (${files.length}):`,
            ...files.map((f) => `- ${compactPath(f)}`),
          ].join("\n")
        : ["Unit tests fail.", "", "Reproduce:", cmd].join("\n"),
    });
  }

  // ── 4. i18n
  onStep?.("i18n: running…");
  const [icmd, ...iargs] = cmds.i18n.trim().split(/\s+/);
  const i18n = await sh([icmd, ...iargs], shadowPath);
  const changed = await statusPaths(shadowPath);
  // Only count files with genuine entry changes — ignore .po/.pot files left
  // dirty by auto-regenerated comment churn (which needs no translation work).
  const meaningful: string[] = [];
  if (i18n.ok && changed.length) {
    for (const f of changed) {
      if (await hasMeaningfulI18nChange(f, shadowPath)) meaningful.push(f);
    }
  }
  const i18nIssues: string[] = [];
  if (i18n.ok && meaningful.length === 0) {
    if (changed.length) {
      step(`✓ i18n: clean (only regenerated comments in ${changed.length} file(s))`);
    } else {
      step("✓ i18n: clean");
    }
  } else {
    step(`⚠ i18n: ${i18n.ok ? `${meaningful.length} file(s) need attention` : "command failed"}`);
    const lines = [`\`${cmds.i18n}\` did not leave a clean tree. Finish the i18n work.`];
    if (meaningful.length) {
      lines.push("Files it changed (likely new/untranslated strings):");
      for (const f of meaningful.slice(0, 20)) lines.push(`  ${f}`);
      lines.push(
        `Fill in missing translations (msgstr) for new/changed entries, then re-run \`${cmds.i18n}\` until clean.`,
      );
    }
    if (!i18n.ok) {
      lines.push(`\`${cmds.i18n}\` exited with an error:`);
      lines.push(tail(`${i18n.out}\n${i18n.err}`, 12));
    }
    lines.push("Edit only source/translation files; do not run the full test suite.");
    i18nIssues.push(lines.join("\n"));
  }
  // Don't leave the shadow dirty for the next remote-commit check / agent pass.
  if (changed.length) {
    await git(["checkout", "--", "."], shadowPath);
    await git(["clean", "-fd"], shadowPath);
  }

  // ── 5. hardcoded (untranslated) strings — the gap `pnpm i18n` can't see
  onStep?.("i18n-scan: scanning for hardcoded strings…");
  const untranslated = await scanRepoForUntranslated(shadowPath);
  const totalUntranslated = untranslated.reduce((s, u) => s + u.findings.length, 0);
  if (totalUntranslated === 0) {
    step("✓ i18n-scan: no hardcoded user-facing strings found");
  } else {
    step(`⚠ i18n-scan: ${totalUntranslated} hardcoded string(s) in ${untranslated.length} file(s)`);
    const lines = [
      "Some user-facing strings are hardcoded (not wrapped in t()), so they always render in the source locale regardless of the chosen language. `pnpm i18n` can't see them because it only extracts strings already wrapped in a translation call.",
      "",
      "Wrap each in t() (use the component's t / $t in Vue templates), then run i18n extraction and fill in the translations.",
      "",
      "Detected occurrences, user-facing display files (.vue / UI) first (this list may be partial — also scan each file below for any OTHER hardcoded user-facing copy):",
    ];
    // Prioritise display files, then by finding count.
    const ordered = [...untranslated].sort(
      (a, b) => Number(b.display) - Number(a.display) || b.findings.length - a.findings.length,
    );
    for (const u of ordered.slice(0, 12)) {
      lines.push(`  ${u.file}`);
      for (const f of u.findings.slice(0, 6)) lines.push(`    ${f.line}: ${f.text}`);
      if (u.findings.length > 6) lines.push(`    … +${u.findings.length - 6} more`);
    }
    if (untranslated.length > 12) {
      lines.push(`  … +${untranslated.length - 12} more file(s)`);
      lines.push("  (run `chong check i18n` for the complete, untruncated list)");
    }
    lines.push("");
    lines.push(
      "Heads up: the heuristic flags non-English string literals, so it includes false positives — log/throw messages, scripts, test fixtures, and data files that are intentionally untranslated. Use judgement; only wrap genuine user-facing copy.",
    );
    lines.push(
      `Some strings may be asserted in unit tests or shared across components — update those call sites/assertions too. After wrapping, run \`${cmds.i18n}\` and fill in the new msgstr entries until the tree is clean. Edit source + translation files only; do not run the full test suite.`,
    );
    i18nIssues.push(lines.join("\n"));
  }

  // ── agent i18n resolve (confidence-gated)
  if (i18nIssues.length > 0) {
    const summary = i18nIssues.join("\n\n---\n\n").slice(0, 6000);
    if (agentI18n) {
      onStep?.("i18n: asking coding agent…");
      const res = await tryAgentI18nFix(repoPath, shadowPath, summary, cmds.i18n, remote, branch);
      step(res.fixed ? `✓ ${res.message}` : `⚠ ${res.message}`);
      if (res.fixed) i18nAgentFixed = true;
      if (res.paused && res.pauseUntil) i18nPauseUntil = res.pauseUntil;
      if (!res.fixed) {
        prompts.push({
          title: i18nIssues.length > 1 ? "finish i18n + wrap hardcoded strings" : "finish i18n",
          text: summary,
        });
      }
    } else {
      prompts.push({
        title: i18nIssues.length > 1 ? "finish i18n + wrap hardcoded strings" : "finish i18n",
        text: summary,
      });
    }
  }

  return { steps, prompts, error: null, i18nPauseUntil, i18nAgentFixed };
}
