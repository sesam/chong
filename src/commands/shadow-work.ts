import { c, parseArgs } from "../util";
import { checkI18n, ensureShadow, isAutoFix, runFormatFix, runI18nFix } from "../watch/checks";
import { repo } from "../watch/repo";

const log = (s: string) => process.stdout.write(`${s}\n`);

export async function cmdShadowWork(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);

  const path = positional[0] ?? process.cwd();
  if (!(await repo.isGitRepo(path))) throw new Error(`${path} is not a git repository`);
  const repoPath = await repo.topLevel(path);

  const remote = typeof flags.remote === "string" ? flags.remote : "origin";
  const formatCmd = typeof flags["format-cmd"] === "string" ? flags["format-cmd"] : "pnpm format";

  // Resolve the head branch (first of the standard pipeline branches that exists)
  const candidates = ["main", "master"];
  const branches = await repo.existingRemoteBranches(repoPath, remote, candidates);
  const headBranch = branches[0];
  if (!headBranch) throw new Error(`could not find ${candidates.join(" or ")} on ${remote}`);

  const ref = `${remote}/${headBranch}`;
  const tip = await repo.tip(repoPath, remote, headBranch);
  const sha = tip.slice(0, 7);

  log(`${c.bold("chong shadow-work")}  ${c.dim(repoPath)}`);
  log(`${c.dim("─".repeat(60))}`);
  log(`commit  ${c.yellow(sha)}  (${ref})`);
  log("");

  // Skip auto-fix commits
  if (await isAutoFix(repoPath, tip)) {
    log(c.dim(`  skipping — ${sha} is an auto-fix commit`));
    return;
  }

  // i18n mismatch check
  process.stdout.write("  i18n check… ");
  const i18n = await checkI18n(repoPath, tip);
  if (!i18n.mismatch) {
    log(c.dim("ok"));
  } else if (i18n.hasI18nCode) {
    log(c.yellow("⚠ i18n code change without .po/.pot update"));
  } else {
    log(c.yellow("⚠ .po/.pot changed without i18n code changes"));
  }

  // Set up shadow worktree
  process.stdout.write("  shadow setup… ");
  const shadow = await ensureShadow(repoPath, ref);
  if (shadow.error) {
    log(c.red(`✗ ${shadow.error}`));
    return;
  }
  log(c.dim(`${shadow.shadowPath}`));

  // i18n auto-fix
  process.stdout.write("  pnpm i18n… ");
  const i18nFix = await runI18nFix(repoPath, shadow.shadowPath, remote, headBranch);
  if (i18nFix.error) {
    log(c.red(`✗ ${i18nFix.error}`));
  } else if (i18nFix.committed && i18nFix.pushed) {
    log(c.green(`✓ committed + pushed to ${headBranch}`));
  } else if (i18nFix.committed) {
    log(c.yellow("committed but push failed"));
  } else {
    log(c.dim("no changes"));
  }
  if (i18nFix.leftovers.length > 0) {
    log(c.yellow(`  ⚠ leftover files (not committed):`));
    for (const f of i18nFix.leftovers) log(`    ${f}`);
  }

  // Format fix
  process.stdout.write(`  ${formatCmd}… `);
  const fmtFix = await runFormatFix(repoPath, shadow.shadowPath, tip, formatCmd, remote, headBranch);
  if (fmtFix.error) {
    log(c.red(`✗ ${fmtFix.error}`));
  } else if (fmtFix.committed && fmtFix.pushed) {
    log(c.green(`✓ committed + pushed to ${headBranch}`));
  } else if (fmtFix.committed) {
    log(c.yellow("committed but push failed"));
  } else {
    log(c.dim("no changes"));
  }

  log("");
  log(c.dim("done."));
}
