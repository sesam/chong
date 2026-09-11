/**
 * Soft ownership of the shared main-shadow worktree.
 *
 * Multiple `chong watch` processes on one machine share `~/.chong/worktrees/<repo>-main-shadow-*`.
 * The owner file lives *beside* the worktree (not inside it) so `git clean -fd` / hard-reset
 * cannot wipe the claim mid-run.
 *
 * Stale detection uses the file's mtime: the owning process touches it every
 * {@link WORKTREE_CLAIM_TOUCH_MS} while commits are still arriving. After that window with
 * no touch, another watch may take over (or the operator can force-override).
 */
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";

export const WORKTREE_CLAIM_TOUCH_MS = 20 * 60 * 1_000;
/** Same window as the touch interval — no touch ⇒ abandoned. */
export const WORKTREE_CLAIM_STALE_MS = WORKTREE_CLAIM_TOUCH_MS;

export type WorktreeClaim = {
  v: 1;
  id: string;
  user: string;
  at: string;
  host?: string;
  pid?: number;
};

export function worktreeOwnerPath(shadowPath: string): string {
  return `${shadowPath}.owner.json`;
}

function identity(): { user: string; host: string } {
  let user = process.env.USER || process.env.LOGNAME || "";
  try {
    if (!user) user = userInfo().username;
  } catch {
    /* ignore */
  }
  if (!user) user = "unknown";
  let host = "";
  try {
    host = hostname();
  } catch {
    /* ignore */
  }
  return { user, host };
}

export function formatWorktreeHolder(claim: WorktreeClaim): string {
  const where = claim.host ? `@${claim.host}` : "";
  const pid = claim.pid != null ? ` pid=${claim.pid}` : "";
  return `${claim.user}${where}${pid}`;
}

export function parseWorktreeClaim(raw: string): WorktreeClaim | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<WorktreeClaim>;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.user !== "string" || !parsed.user) return null;
    if (typeof parsed.at !== "string" || !parsed.at) return null;
    return {
      v: 1,
      id: parsed.id,
      user: parsed.user,
      at: parsed.at,
      ...(typeof parsed.host === "string" && parsed.host ? { host: parsed.host } : {}),
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
    };
  } catch {
    return null;
  }
}

export function readWorktreeClaim(shadowPath: string): WorktreeClaim | null {
  const p = worktreeOwnerPath(shadowPath);
  if (!existsSync(p)) return null;
  try {
    return parseWorktreeClaim(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Active when the owner file exists and its mtime is within the stale window. */
export function isWorktreeClaimActive(shadowPath: string, nowMs = Date.now()): boolean {
  const p = worktreeOwnerPath(shadowPath);
  if (!existsSync(p)) return false;
  try {
    const st = statSync(p);
    return nowMs - st.mtimeMs < WORKTREE_CLAIM_STALE_MS;
  } catch {
    return false;
  }
}

export function writeWorktreeClaim(shadowPath: string, claim: WorktreeClaim): void {
  const p = worktreeOwnerPath(shadowPath);
  writeFileSync(p, `${JSON.stringify(claim)}\n`, "utf8");
}

/** Refresh mtime (and `at`) so other watches see we are still alive. */
export function touchWorktreeClaim(shadowPath: string, processId: string): boolean {
  const current = readWorktreeClaim(shadowPath);
  if (!current || current.id !== processId) return false;
  const next: WorktreeClaim = { ...current, at: new Date().toISOString() };
  writeWorktreeClaim(shadowPath, next);
  try {
    const now = new Date();
    utimesSync(worktreeOwnerPath(shadowPath), now, now);
  } catch {
    /* write already refreshed content */
  }
  return true;
}

/**
 * Delete the owner file only if it still names this process.
 * Call this first during watch shutdown.
 */
export function releaseWorktreeClaim(shadowPath: string, processId: string): boolean {
  const p = worktreeOwnerPath(shadowPath);
  if (!existsSync(p)) return true;
  const current = readWorktreeClaim(shadowPath);
  if (current && current.id !== processId) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export type WorktreeAcquireResult =
  | { ok: true; claim: WorktreeClaim; forced?: boolean }
  | { ok: false; reason: "held"; claim: WorktreeClaim };

/**
 * Claim the shared shadow worktree for this watch process.
 * @param force overwrite a live foreign claim (operator override).
 */
export function acquireWorktreeClaim(
  shadowPath: string,
  processId: string,
  opts: { force?: boolean } = {},
): WorktreeAcquireResult {
  const { user, host } = identity();
  const mine: WorktreeClaim = {
    v: 1,
    id: processId,
    user,
    at: new Date().toISOString(),
    pid: process.pid,
    ...(host ? { host } : {}),
  };

  const existing = readWorktreeClaim(shadowPath);
  const active = isWorktreeClaimActive(shadowPath);

  if (existing && active && existing.id !== processId && !opts.force) {
    return { ok: false, reason: "held", claim: existing };
  }

  writeWorktreeClaim(shadowPath, mine);
  return {
    ok: true,
    claim: mine,
    forced: Boolean(opts.force && existing && existing.id !== processId),
  };
}
