/**
 * Lockfile-driven dependency sync for shadow worktrees (`node_modules` / `.venv`).
 *
 * Shadow worktrees symlink `node_modules` (and `.venv`) from the source checkout so builds
 * stay fast (`DEPLOY_SKIP_INSTALL=1`). On a developer's laptop, the dev runs `pnpm install`
 * periodically; on an always-on VM, nobody runs it manually while incoming commits and
 * auto-maintain keep advancing `pnpm-lock.yaml` / `uv.lock`.
 *
 * Before a build/deploy, this checks the SHA-256 of the lockfile against the last synced
 * hash recorded in `<repo>/.chong/deps-sync.json`:
 *   - Unchanged + deps dir exists ⇒ O(1) no-op (<1ms).
 *   - Shadow lockfile matches source lockfile, but hash changed or deps dir missing ⇒
 *     serialized `pnpm install --frozen-lockfile` (or `uv sync --frozen`) in `repoPath`,
 *     updating all symlinked shadows at once.
 *   - Shadow lockfile differs from source lockfile (e.g. source is on an older branch) and
 *     `allowShadowInstall` is true ⇒ replaces only the shadow's symlink with a shadow-local
 *     frozen install so the deploy ships the exact dependency graph of the target commit.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readStreamCapped } from "./runtime";

const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

export type DepsSyncState = {
  pnpmLockHash?: string;
  uvLockHash?: string;
  updatedAt?: string;
};

export type DepsSyncResult = {
  action: "noop" | "synced-repo" | "synced-shadow" | "skipped" | "error";
  tool?: "pnpm" | "uv";
  message: string;
};

export function hashFileSync(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const buf = readFileSync(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function syncStatePath(repoPath: string): string {
  return path.join(repoPath, ".chong", "deps-sync.json");
}

export function readDepsSyncState(repoPath: string): DepsSyncState {
  try {
    const p = syncStatePath(repoPath);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as DepsSyncState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDepsSyncState(repoPath: string, state: DepsSyncState): void {
  const p = syncStatePath(repoPath);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

type Installer = (cmd: string[], cwd: string) => Promise<{ ok: boolean; err: string }>;

async function defaultInstaller(cmd: string[], cwd: string): Promise<{ ok: boolean; err: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: SYNC_TIMEOUT_MS,
      env: { ...process.env, CI: "true", GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err, code] = await Promise.all([
      readStreamCapped(proc.stdout, 32 * 1024),
      readStreamCapped(proc.stderr, 32 * 1024),
      proc.exited,
    ]);
    if (proc.signalCode !== null && proc.killed) {
      return {
        ok: false,
        err: `${cmd[0]} timed out after ${Math.round(SYNC_TIMEOUT_MS / 60000)}m`,
      };
    }
    if (code !== 0) {
      const msg = (err || out).trim().split("\n").slice(-4).join(" | ");
      return { ok: false, err: msg || `${cmd.join(" ")} exited ${code}` };
    }
    return { ok: true, err: "" };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/** Serialize installs per repoPath so parallel stage + prod deploys never race pnpm/uv. */
const repoSyncLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoSyncLocks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.finally(() => {
    if (repoSyncLocks.get(repoPath) === cleanup) repoSyncLocks.delete(repoPath);
  });
  repoSyncLocks.set(repoPath, cleanup);
  return next;
}

/** Unlink `dirPath` ONLY if it is a symlink (never removes a real directory in repoPath). */
function unlinkIfSymlink(dirPath: string): void {
  try {
    if (lstatSync(dirPath).isSymbolicLink()) unlinkSync(dirPath);
  } catch {
    /* nothing there */
  }
}

export async function ensureShadowDepsSynced(
  repoPath: string,
  shadowPath: string,
  opts: {
    /** If shadow lockfile != source lockfile, install into shadowPath (for deploys). */
    allowShadowInstall?: boolean;
    onProgress?: (msg: string) => void;
    installer?: Installer;
    /** Override binary availability check for tests. */
    hasBin?: (bin: string) => boolean;
  } = {},
): Promise<DepsSyncResult> {
  const run = opts.installer ?? defaultInstaller;
  const hasBin = opts.hasBin ?? ((b: string) => Boolean(Bun.which(b)));

  // ── Node / pnpm
  const shadowPnpmHash = hashFileSync(path.join(shadowPath, "pnpm-lock.yaml"));
  if (shadowPnpmHash) {
    if (!hasBin("pnpm")) {
      return { action: "skipped", tool: "pnpm", message: "pnpm not on PATH" };
    }
    return withRepoLock(repoPath, async () => {
      const repoPnpmHash = hashFileSync(path.join(repoPath, "pnpm-lock.yaml"));
      const state = readDepsSyncState(repoPath);
      const repoHasNm = existsSync(path.join(repoPath, "node_modules"));

      if (repoPnpmHash === shadowPnpmHash) {
        if (repoHasNm && state.pnpmLockHash === shadowPnpmHash) {
          return { action: "noop", tool: "pnpm", message: "node_modules matches pnpm-lock.yaml" };
        }
        opts.onProgress?.(
          "deps sync: pnpm-lock.yaml changed — running pnpm install --frozen-lockfile…",
        );
        const r = await run(["pnpm", "install", "--frozen-lockfile"], repoPath);
        if (!r.ok) {
          return { action: "error", tool: "pnpm", message: `pnpm install failed: ${r.err}` };
        }
        writeDepsSyncState(repoPath, { ...state, pnpmLockHash: shadowPnpmHash });
        return {
          action: "synced-repo",
          tool: "pnpm",
          message: "synced node_modules with pnpm-lock.yaml",
        };
      }

      if (!opts.allowShadowInstall) {
        return {
          action: "skipped",
          tool: "pnpm",
          message: "shadow pnpm-lock.yaml differs from source checkout — skipped repo install",
        };
      }
      // Deploy shadow has a different lockfile than source checkout: detach symlink so we
      // never mutate the source repo's node_modules, and install cleanly inside the shadow.
      opts.onProgress?.(
        "deps sync: shadow lockfile differs from checkout — installing into deploy shadow…",
      );
      unlinkIfSymlink(path.join(shadowPath, "node_modules"));
      const r = await run(["pnpm", "install", "--frozen-lockfile"], shadowPath);
      if (!r.ok) {
        return { action: "error", tool: "pnpm", message: `shadow pnpm install failed: ${r.err}` };
      }
      return {
        action: "synced-shadow",
        tool: "pnpm",
        message: "installed exact shadow node_modules",
      };
    });
  }

  // ── Python / uv
  const shadowUvHash = hashFileSync(path.join(shadowPath, "uv.lock"));
  if (shadowUvHash) {
    if (!hasBin("uv")) {
      return { action: "skipped", tool: "uv", message: "uv not on PATH" };
    }
    return withRepoLock(repoPath, async () => {
      const repoUvHash = hashFileSync(path.join(repoPath, "uv.lock"));
      const state = readDepsSyncState(repoPath);
      const repoHasVenv = existsSync(path.join(repoPath, ".venv"));

      if (repoUvHash === shadowUvHash) {
        if (repoHasVenv && state.uvLockHash === shadowUvHash) {
          return { action: "noop", tool: "uv", message: ".venv matches uv.lock" };
        }
        opts.onProgress?.("deps sync: uv.lock changed — running uv sync --frozen…");
        const r = await run(["uv", "sync", "--frozen"], repoPath);
        if (!r.ok) {
          return { action: "error", tool: "uv", message: `uv sync failed: ${r.err}` };
        }
        writeDepsSyncState(repoPath, { ...state, uvLockHash: shadowUvHash });
        return { action: "synced-repo", tool: "uv", message: "synced .venv with uv.lock" };
      }

      if (!opts.allowShadowInstall) {
        return {
          action: "skipped",
          tool: "uv",
          message: "shadow uv.lock differs from source checkout — skipped repo sync",
        };
      }
      opts.onProgress?.("deps sync: shadow uv.lock differs — syncing inside deploy shadow…");
      unlinkIfSymlink(path.join(shadowPath, ".venv"));
      const r = await run(["uv", "sync", "--frozen"], shadowPath);
      if (!r.ok) {
        return { action: "error", tool: "uv", message: `shadow uv sync failed: ${r.err}` };
      }
      return { action: "synced-shadow", tool: "uv", message: "installed exact shadow .venv" };
    });
  }

  return { action: "noop", message: "no pnpm-lock.yaml or uv.lock" };
}
