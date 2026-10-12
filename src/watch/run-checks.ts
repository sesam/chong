import path from "node:path";
import { type RepoCheck, type RepoCheckPhase, filterByGlobs, splitArgv } from "./repo-config";
import { checksForPhase } from "./repo-profile";

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
};

const TAIL_LINES = 40;

async function run(argv: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
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
      await run([...splitArgv(ck.fixCmd), ...extra], cwd);
      fixed = true;
    }
    const r = await run(argv, cwd);
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
