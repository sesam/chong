import { c, parseArgs } from "../util";
import {
  checkI18n,
  ensureShadow,
  isAutoFix,
  runFormatFix,
  runI18nFix,
  shadowPathFor,
} from "../watch/checks";
import { repo } from "../watch/repo";
import {
  acquireWorktreeClaim,
  formatWorktreeHolder,
  releaseWorktreeClaim,
} from "../watch/worktree-claim";

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

  // Claim the shared main-shadow worktree before touching it.
  //
  // Everything above is read-only against the source repo, so the claim is taken here
  // rather than up front — no point blocking a `chong watch` while we only print a
  // diff summary. Below this line we reset the worktree hard, so we must own it: this
  // command used to proceed unclaimed and could `clean -fd` / `reset --hard` under a
  // watch's in-flight deploy, then commit and push its own result on top.
  //
  // This is a new refusal, and deliberate: `shadow-work` now declines while a watch
  // owns the worktree instead of silently fighting it.
  const processId = crypto.randomUUID();
  const shadowPath = shadowPathFor(repoPath);
  const claim = acquireWorktreeClaim(shadowPath, processId);
  if (!claim.ok) {
    log("");
    log(c.red(`✗ main-shadow is claimed by ${formatWorktreeHolder(claim.claim)}`));
    log(
      c.dim(
        "  That process (most likely a `chong watch`) may be mid-deploy or mid-agent-edit\n" +
          "  in the shared worktree. shadow-work will not reset a worktree it does not own.\n" +
          "  Wait for it to finish, stop it, or use that watch's [o] override.",
      ),
    );
    return;
  }

  try {
    await runShadowFixes(repoPath, ref, tip, remote, headBranch, formatCmd, processId);
  } finally {
    // Best effort: a Ctrl-C that kills us outright leaves the claim behind, and the
    // stale window (20m) is what clears it. That is the same bargain `chong watch` makes.
    releaseWorktreeClaim(shadowPath, processId);
  }
}

/** The mutating half of `chong shadow-work`, run under an acquired worktree claim. */
async function runShadowFixes(
  repoPath: string,
  ref: string,
  tip: string,
  remote: string,
  headBranch: string,
  formatCmd: string,
  processId: string,
): Promise<void> {
  // Set up shadow worktree
  process.stdout.write("  shadow setup… ");
  const shadow = await ensureShadow(repoPath, ref, { processId });
  if (shadow.error) {
    log(c.red(`✗ ${shadow.error}`));
    return;
  }
  log(c.dim(`${shadow.shadowPath}`));
  for (const w of shadow.warnings ?? []) log(c.yellow(`  ⚠ ${w}`));

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
