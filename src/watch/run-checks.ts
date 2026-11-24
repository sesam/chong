import path from "node:path";
import { type RepoCheck, type RepoCheckPhase, filterByGlobs, splitArgv } from "./repo-config";
import { checksForPhase } from "./repo-profile";
import { readStreamCapped } from "./runtime";

const CHECK_TIMEOUT_MS = 10 * 60 * 1_000;

export type CheckResult = {
  name: string;
  status: "pass" | "fail" | "skipped";
  /** Why skipped, or the tail of the failing output. */
  detail: string;
  ran: string;
  fixed?: boolean;
};

export type RunChecksOpts = {
  /** Repo-relative paths. Undefined = whole repo (`scope: "files"` checks get "."). */
  files?: string[];
  phase: RepoCheckPhase;
  /** Run `fixCmd` first, then (re-)check. */
  fix?: boolean;
  /** Extra environment for the check commands (e.g. CHONG_TARGET for a deploy gate). */
  env?: Record<string, string>;
};

const TAIL_LINES = 40;

async function run(
  argv: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; text: string }> {
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHECK_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    });
    const [out, err, code] = await Promise.all([
      readStreamCapped(proc.stdout, 256 * 1024),
      readStreamCapped(proc.stderr, 256 * 1024),
      proc.exited,
    ]);
    if (proc.signalCode !== null && proc.killed) {
      return {
        ok: false,
        text: `${argv[0]} timed out after ${Math.round(CHECK_TIMEOUT_MS / 60000)}m`,
      };
    }
    return { ok: code === 0, text: `${out}${err}`.trim() };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

function tail(text: string): string {
  return text.split("\n").slice(-TAIL_LINES).join("\n");
}

/** Run the applicable checks. Never throws; a failing/missing tool is a `fail` result. */
export async function runChecks(
  repoPath: string,
  checks: RepoCheck[],
  opts: RunChecksOpts,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const ck of checksForPhase(checks, opts.phase)) {
    const cwd = ck.cwd ? path.join(repoPath, ck.cwd) : repoPath;
    const wholeRepo = opts.files === undefined;
    const matched = wholeRepo ? [] : filterByGlobs(opts.files ?? [], ck.match);
    if (!wholeRepo && matched.length === 0 && (ck.scope === "files" || ck.match)) {
      results.push({ name: ck.name, status: "skipped", detail: "no matching files", ran: "" });
      continue;
    }
    const extra = ck.scope === "files" ? (wholeRepo ? ["."] : matched) : [];
    const argv = [...splitArgv(ck.cmd), ...extra];
    let fixed = false;
    if (opts.fix && ck.fixCmd) {
      await run([...splitArgv(ck.fixCmd), ...extra], cwd, opts.env);
      fixed = true;
    }
    const r = await run(argv, cwd, opts.env);
    results.push({
      name: ck.name,
      status: r.ok ? "pass" : "fail",
      detail: r.ok ? "" : tail(r.text),
      ran: argv.join(" "),
      fixed,
    });
  }
  return results;
}

export function anyFailed(results: CheckResult[]): boolean {
  return results.some((r) => r.status === "fail");
}
