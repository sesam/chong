import { c, parseArgs } from "../util";
import {
  defaultGateDeps,
  describeTarget,
  effectiveTargetCmd,
  formatStatus,
  resolveDeployTargets,
  runTargetDeploy,
  targetStatus,
} from "../watch/deploy-targets";
import { repo } from "../watch/repo";

const USAGE =
  "usage: chong deploy <target> [--sha <sha>] [--yes] [--force-gate]\n       chong deploy --list";

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--verify", `${rev}^{commit}`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 ? out : null;
}

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

/**
 * `chong deploy <target>` — gated local deploy of one declared target (see
 * `watch/deploy-targets.ts`). Always deploys a commit that is on `<remote>/main`; always
 * asks first unless `--yes`.
 */
export async function cmdDeploy(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const repoPath = await repo.topLevel(process.cwd());
  const remote = typeof flags.remote === "string" ? flags.remote : "origin";
  const mainBranch = typeof flags.branch === "string" ? flags.branch : "main";

  const { targets, errors } = await resolveDeployTargets(repoPath);
  for (const e of errors) console.error(c.red(`✗ .chong/config.json ${e}`));
  if (targets.length === 0) {
    console.error(c.red("✗ no deploy targets configured (`targets` in .chong/config.json)"));
    process.exit(1);
  }

  // Best effort: the staleness / on-remote checks are only meaningful against a fresh ref.
  await Bun.spawn(["git", "fetch", remote, mainBranch], { cwd: repoPath, stderr: "pipe" }).exited;

  const sha =
    typeof flags.sha === "string"
      ? await revParse(repoPath, flags.sha)
      : await revParse(repoPath, `${remote}/${mainBranch}`);
  if (!sha) {
    console.error(c.red("✗ could not resolve the SHA to deploy"));
    process.exit(1);
  }

  if (flags.list === true) {
    for (const t of targets) {
      const st = await targetStatus(repoPath, t, sha);
      console.log(
        `${describeTarget(t).padEnd(28)} ${formatStatus(st)}${t.auto ? c.dim("  auto") : ""}`,
      );
      console.log(c.dim(`${"".padEnd(28)} $ ${effectiveTargetCmd(repoPath, t)}`));
    }
    return;
  }

  const target = targets.find((t) => t.name === positional[0]);
  if (!target) {
    console.error(c.red(`✗ unknown target: ${positional[0] ?? "(none)"}`));
    console.error(c.dim(`  known: ${targets.map((t) => t.name).join(", ")}`));
    console.error(c.dim(USAGE));
    process.exit(1);
  }

  if (flags.yes !== true) {
    const ok = await confirm(
      c.yellow(
        `Deploy ${describeTarget(target)} @ ${sha.slice(0, 7)} from this machine (\`${effectiveTargetCmd(repoPath, target)}\`)${
          flags["force-gate"] === true ? " WITHOUT the check/CI gate" : ""
        }? [y/N] `,
      ),
    );
    if (!ok) {
      console.log(c.dim("aborted"));
      return;
    }
  }

  const res = await runTargetDeploy(repoPath, remote, mainBranch, sha, target, {
    forceGate: flags["force-gate"] === true,
    gate: defaultGateDeps(repoPath, (m) => console.log(c.dim(`  ${m}`))),
    onProgress: (m) => console.log(c.dim(`  ${m}`)),
  });
  if (res.action === "deployed") console.log(c.green(`✓ ${res.message}`));
  else if (res.action === "noop") console.log(c.dim(res.message));
  else {
    console.error(c.red(`✗ ${res.message}`));
    process.exit(1);
  }
}
