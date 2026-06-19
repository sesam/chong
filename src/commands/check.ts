import { resolve } from "node:path";
import { c, parseArgs } from "../util";
import { type FileFindings, scanRepoForUntranslated } from "../watch/checks";
import { repo } from "../watch/repo";

const log = (s: string) => process.stdout.write(`${s}\n`);

const USAGE = `usage: chong check i18n [<path>] [--all] [--json]

  Scan tracked source for hardcoded, user-facing strings that aren't wrapped in
  t() — the gap pnpm i18n can't see. Prints the complete list (file:line: text)
  so you can eyeball it and tune the detector.

  <path>    limit the scan to a file or directory (default: whole repo)
  --all     include non-UI files skipped by default (scripts, tests, fixtures,
            data files); .md and other non-source files are never scanned
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
  const includeExcluded = flags.all === true;

  const results = await scanRepoForUntranslated(repoPath, pathspec, includeExcluded);
  const total = results.reduce((s, r) => s + r.findings.length, 0);

  if (flags.json) {
    log(
      JSON.stringify(
        { repoPath, pathspec: pathspec ?? null, includeExcluded, total, files: results },
        null,
        2,
      ),
    );
    return;
  }

  log(`${c.bold("chong check i18n")}  ${c.dim(pathspec ?? repoPath)}`);
  log(c.dim("─".repeat(64)));

  if (results.length === 0) {
    log(c.green("✓ no hardcoded strings detected"));
    return;
  }

  // Two groups: user-facing display files (.vue / JSX / UI-rendering) first, then
  // everything else (logic, services, content/data modules). Worst files first.
  const byCount = (a: FileFindings, b: FileFindings) => b.findings.length - a.findings.length;
  const ui = results.filter((r) => r.display).sort(byCount);
  const other = results.filter((r) => !r.display).sort(byCount);
  const countOf = (g: FileFindings[]) => g.reduce((s, r) => s + r.findings.length, 0);

  const section = (title: string, group: FileFindings[]) => {
    if (group.length === 0) return;
    log(c.bold(title));
    for (const r of group) {
      log(`${c.cyan(r.file)} ${c.dim(`(${r.findings.length})`)}`);
      for (const f of r.findings) log(`  ${c.dim(`${f.line}:`)} ${f.text}`);
    }
    log("");
  };

  section("▌ display components (.vue / UI) — prioritised", ui);
  section("▌ other files (logic / content)", other);

  log(
    `${c.yellow(String(countOf(ui)))} in ${ui.length} display file(s)  ${c.dim("·")}  ${c.yellow(
      String(countOf(other)),
    )} in ${other.length} other file(s)  ${c.dim("·")}  ${total} total`,
  );
  log(c.dim("expect false positives — this is a detection feedback view, not a fix list"));
  if (!includeExcluded) {
    log(c.dim("scripts/tests/fixtures/data files are skipped; pass --all to include them"));
  }
}
