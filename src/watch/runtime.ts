/**
 * Shared runtime primitives for long-running / always-on `chong watch` instances:
 *   - BoundedSet: FIFO-evicting Set so long-lived tracking structures never leak RAM.
 *   - readStreamCapped: drains a child stdout/stderr stream keeping only the tail in memory
 *     (and optionally teeing full bytes to a log file).
 *   - WatchLogger: rotating persistent log file + optional headless stdout sink.
 *   - ShutdownRegistry: tracks active detached process groups, worktree claims, and S3
 *     deploy claims so SIGINT / SIGTERM / SIGHUP can abort uploads and release every claim.
 *   - deployAwsEnv: scopes deploy + S3 marker calls to a dedicated AWS profile when set.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Accepts both 40-char Git SHA-1 and 64-char Git SHA-256 / akk commit hashes (or short prefixes). */
export const HEX_SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * FIFO-bounded Set. Subclasses native `Set` so it is assignable to `Set<T>` / `ReadonlySet<T>`
 * and evicts the oldest entry once `size > maxSize`.
 */
export class BoundedSet<T> extends Set<T> {
  private readonly maxSize: number;

  constructor(maxSize = 1000, initial?: Iterable<T>) {
    super();
    this.maxSize = Math.max(1, maxSize);
    if (initial) {
      for (const v of initial) this.add(v);
    }
  }

  override add(value: T): this {
    if (super.has(value)) return this;
    super.add(value);
    if (this.size > this.maxSize) {
      const oldest = this.values().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return this;
  }
}

/**
 * Drain a ReadableStream while capping in-memory retention to the last `maxBytes` bytes.
 * Optionally writes the full, untruncated stream to `logFd` on disk as chunks arrive.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes = 256 * 1024,
  logFd?: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (logFd !== undefined) {
        try {
          writeSync(logFd, value);
        } catch {
          /* best effort log write */
        }
      }
      if (value.byteLength >= maxBytes) {
        chunks.length = 0;
        chunks.push(value.subarray(value.byteLength - maxBytes));
        keptBytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(value);
        keptBytes += value.byteLength;
        while (keptBytes > maxBytes && chunks.length > 1) {
          const dropped = chunks.shift();
          if (dropped) keptBytes -= dropped.byteLength;
          truncated = true;
        }
        if (keptBytes > maxBytes && chunks.length === 1) {
          const only = chunks[0];
          chunks[0] = only.subarray(only.byteLength - maxBytes);
          keptBytes = maxBytes;
          truncated = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(keptBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  return truncated ? `…[earlier output truncated]\n${text}` : text;
}

/** Open a 0600 log file under ~/.chong/logs for streaming deploy output; null on failure. */
export function openDeployLogFile(
  target: string,
  sha: string,
): { path: string; fd: number } | null {
  try {
    const dir = path.join(homedir(), ".chong", "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeTarget = target.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = path.join(dir, `deploy-${safeTarget}-${sha.slice(0, 7)}.log`);
    const fd = openSync(file, "w", 0o600);
    return { path: file, fd };
  } catch {
    return null;
  }
}

export function closeFdSafe(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
}

/** Keep at most `maxFiles` deploy-*.log files under ~/.chong/logs (oldest pruned first). */
export function pruneDeployLogs(maxFiles = 50): void {
  try {
    const dir = path.join(homedir(), ".chong", "logs");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("deploy-") && f.endsWith(".log"))
      .map((f) => {
        const full = path.join(dir, f);
        try {
          return { full, mtimeMs: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { full: string; mtimeMs: number } => x !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of files.slice(maxFiles)) {
      try {
        unlinkSync(old.full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best effort */
  }
}

/** Write a complete redacted deploy log to ~/.chong/logs (0600) and prune old logs. */
export function writeDeployLogFile(target: string, sha: string, text: string): string | null {
  try {
    const dir = path.join(homedir(), ".chong", "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeTarget = target.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = path.join(dir, `deploy-${safeTarget}-${sha.slice(0, 7)}.log`);
    writeFileSync(file, `${text}\n`, { mode: 0o600 });
    pruneDeployLogs();
    return file;
  } catch {
    return null;
  }
}

// ── Watch rotating log file ──────────────────────────────────────────────────

// Built via RegExp so ESC isn't a control-char regex literal (biome rule).
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsiCodes(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

const WATCH_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

export function defaultWatchLogPath(repoPath: string): string {
  const base = path.basename(repoPath).replace(/[^a-zA-Z0-9._-]/g, "_") || "repo";
  const hash = createHash("sha1").update(repoPath).digest("hex").slice(0, 8);
  return path.join(homedir(), ".chong", "logs", `watch-${base}-${hash}.log`);
}

export class WatchLogger {
  readonly filePath: string | null;
  private readonly echoStdout: boolean;
  private writes = 0;

  constructor(opts: { filePath?: string | null; echoStdout?: boolean } = {}) {
    this.filePath = opts.filePath ?? null;
    this.echoStdout = opts.echoStdout === true;
    if (this.filePath) {
      try {
        mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      } catch {
        /* best effort */
      }
    }
  }

  log(level: "info" | "warn" | "error", rawMessage: string): void {
    const clean = stripAnsiCodes(rawMessage).replace(/\r?\n/g, " | ").trim();
    if (!clean) return;
    const line = `${new Date().toISOString()} [${level}] ${clean}\n`;
    if (this.echoStdout) {
      try {
        process.stdout.write(line);
      } catch {
        /* ignore */
      }
    }
    if (!this.filePath) return;
    try {
      this.writes += 1;
      if (this.writes % 64 === 0) this.rotateIfNeeded();
      appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      /* logging must never crash watch */
    }
  }

  private rotateIfNeeded(): void {
    if (!this.filePath) return;
    try {
      const st = statSync(this.filePath);
      if (st.size >= WATCH_LOG_MAX_BYTES) {
        renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      /* ignore */
    }
  }
}

// ── Deploy AWS profile scoping (1C) ──────────────────────────────────────────

let configuredDeployAwsProfile: string | null = null;

/** Configure a dedicated AWS profile for deploy commands + S3 marker/claim calls. */
export function setDeployAwsProfile(profile: string | null | undefined): void {
  const trimmed = profile?.trim() || "";
  configuredDeployAwsProfile = trimmed || null;
}

/** Active deploy AWS profile (explicit CLI flag > CHONG_DEPLOY_AWS_PROFILE > null). */
export function getDeployAwsProfile(): string | null {
  return configuredDeployAwsProfile || process.env.CHONG_DEPLOY_AWS_PROFILE?.trim() || null;
}

/**
 * Environment for deploy commands and S3 marker/claim operations.
 * When `CHONG_DEPLOY_AWS_PROFILE` (or `--deploy-aws-profile`) is configured, sets
 * `AWS_PROFILE` and drops raw static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
 * `AWS_SESSION_TOKEN` so the scoped profile actually takes precedence over ambient keys.
 */
const AMBIENT_AWS_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

export function deployAwsEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const profile = getDeployAwsProfile();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (profile && AMBIENT_AWS_KEYS.has(k)) continue;
    out[k] = v;
  }
  if (profile) out.AWS_PROFILE = profile;
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v;
  }
  return out;
}

// ── Process-wide active resource registry for graceful shutdown (1B) ─────────

type CleanupHook = {
  id: string;
  /** Synchronous fast cleanup (e.g. signal detached child group, unlink worktree claim). */
  sync?: () => void;
  /** Best-effort async cleanup (e.g. delete S3 deploy claim). */
  async?: () => Promise<void>;
};

const activeHooks = new Map<string, CleanupHook>();

/** Register an active process group or claim to be torn down if chong exits mid-operation. */
export function registerShutdownHook(hook: Omit<CleanupHook, "id">): () => void {
  const id = crypto.randomUUID();
  activeHooks.set(id, { id, ...hook });
  return () => {
    activeHooks.delete(id);
  };
}

/**
 * Register a detached child process group (`detached: true`) so shutdown sends SIGTERM
 * (and escalates to SIGKILL) to `-pid`.
 */
export function registerActiveProcessGroup(pid: number): () => void {
  return registerShutdownHook({
    sync: () => {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const t = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2_000);
      t.unref();
    },
  });
}

/** Run all synchronous shutdown hooks (safe from uncaughtException / crash net). */
export function runSyncShutdownHooks(): void {
  for (const h of [...activeHooks.values()]) {
    try {
      h.sync?.();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Run all registered sync + async shutdown hooks, bounded by `timeoutMs`.
 * Used by graceful SIGINT / SIGTERM / SIGHUP / [q] shutdown so S3 deploy claims are
 * deleted and detached deploy/agent trees are stopped cleanly.
 */
export async function runAllShutdownHooks(timeoutMs = 5_000): Promise<void> {
  const hooks = [...activeHooks.values()];
  activeHooks.clear();
  for (const h of hooks) {
    try {
      h.sync?.();
    } catch {
      /* best effort */
    }
  }
  const asyncTasks = hooks
    .filter((h) => typeof h.async === "function")
    .map((h) =>
      Promise.resolve()
        .then(() => h.async?.())
        .catch(() => {}),
    );
  if (asyncTasks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  await Promise.race([Promise.allSettled(asyncTasks), deadline]);
  if (timer) clearTimeout(timer);
}
