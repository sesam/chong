import { c, parseArgs } from "../util";
import { repo } from "../watch/repo";
import type { RepoCheckPhase } from "../watch/repo-config";
import { detectRepoProfile } from "../watch/repo-profile";
import { type CheckResult, anyFailed, runChecks } from "../watch/run-checks";

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\0").filter(Boolean);
}

/** Uncommitted + staged paths vs HEAD (existing files only) plus untracked ones. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const tracked = await gitLines(cwd, ["diff", "--name-only", "--diff-filter=d", "-z", "HEAD"]);
  const untracked = await gitLines(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...tracked, ...untracked])];
}

export function printResults(results: CheckResult[]): void {
  for (const r of results) {
    if (r.status === "pass")
      console.log(`${c.green("✓")} ${r.name}${r.fixed ? c.dim(" (fixed)") : ""}`);
    else if (r.status === "skipped") console.log(c.dim(`· ${r.name}: skipped (${r.detail})`));
    else {
      console.log(`${c.red("✗")} ${r.name}  ${c.dim(r.ran)}`);
      console.log(r.detail.replace(/^/gm, "    "));
    }
  }
}

/**
 * `chong verify` — run the repo's declared/detected checks (see watch/repo-profile.ts).
 * Defaults to the changed files; `--all` checks the whole repo (what a deploy gate does).
 */
export async function cmdVerify(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const cwd = positional[0] ?? process.cwd();
  if (!(await repo.isGitRepo(cwd))) throw new Error(`${cwd} is not a git repository`);
  const repoPath = await repo.topLevel(cwd);

  const phaseFlag = typeof flags.phase === "string" ? flags.phase : "commit";
  if (phaseFlag !== "commit" && phaseFlag !== "deploy") {
    throw new Error(`--phase must be commit or deploy, got "${phaseFlag}"`);
  }
  const phase: RepoCheckPhase = phaseFlag;
  const profile = detectRepoProfile(repoPath);
  const all = flags.all === true || phase === "deploy";
  const files = all ? undefined : await changedFiles(repoPath);

  const results = await runChecks(repoPath, profile.checks, {
    files,
    phase,
    fix: flags.fix === true,
  });

  if (flags.json === true) {
    console.log(JSON.stringify({ kind: profile.kind, phase, results }, null, 2));
  } else if (profile.checks.length === 0) {
    console.log(
      c.dim(`no checks for this ${profile.kind} repo (declare "checks" in .chong/config.json)`),
    );
  } else {
    printResults(results);
  }
  if (anyFailed(results)) process.exit(1);
}
