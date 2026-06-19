import { resolve } from "node:path";
import { c, parseArgs } from "../util";
import { scanRepoForUntranslated } from "../watch/checks";
import { repo } from "../watch/repo";

const log = (s: string) => process.stdout.write(`${s}\n`);

const USAGE = `usage: chong check i18n [<path>] [--json]

  Scan tracked source for hardcoded, user-facing strings that aren't wrapped in
  t() — the gap pnpm i18n can't see. Prints the complete list (file:line: text)
  so you can eyeball it and tune the detector.

  <path>    limit the scan to a file or directory (default: whole repo)
  --json    machine-readable output

  Heuristic: a string literal / template text carrying a non-source-locale signal
  (a non-ASCII letter, or a distinctive Slovenian function word) and not inside a
  t(...) call. It's a candidate flagger, so expect false positives (log/throw
  strings, scripts, code the lexer mis-read) — that's what this view is for.`;

export async function cmdCheck(argv: string[]): Promise<void> {
  const sub = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  if (!sub || sub === "-h" || sub === "--help" || flags.help || flags.h) {
    log(USAGE);
    return;
  }
  if (sub !== "i18n") {
    throw new Error(`unknown check: ${sub} (only "i18n" is supported)`);
  }

  const cwd = process.cwd();
  if (!(await repo.isGitRepo(cwd))) throw new Error(`${cwd} is not a git repository`);
  const repoPath = await repo.topLevel(cwd);

  // A path argument scopes the scan; resolve it to an absolute path so git ls-files
  // (run from the repo root) accepts it regardless of which subdir we're invoked from.
  const pathspec = positional[0] ? resolve(cwd, positional[0]) : undefined;

  const results = await scanRepoForUntranslated(repoPath, pathspec);
  const total = results.reduce((s, r) => s + r.findings.length, 0);

  if (flags.json) {
    log(JSON.stringify({ repoPath, pathspec: pathspec ?? null, total, files: results }, null, 2));
    return;
  }

  log(`${c.bold("chong check i18n")}  ${c.dim(pathspec ?? repoPath)}`);
  log(c.dim("─".repeat(64)));

  if (results.length === 0) {
    log(c.green("✓ no hardcoded strings detected"));
    return;
  }

  // Most-affected files first, so the worst offenders are at the top.
  results.sort((a, b) => b.findings.length - a.findings.length);
  for (const r of results) {
    log(`${c.cyan(r.file)} ${c.dim(`(${r.findings.length})`)}`);
    for (const f of r.findings) log(`  ${c.dim(`${f.line}:`)} ${f.text}`);
  }

  log("");
  log(`${c.yellow(String(total))} hardcoded string(s) across ${results.length} file(s)`);
  log(c.dim("expect false positives — this is a detection feedback view, not a fix list"));
}
