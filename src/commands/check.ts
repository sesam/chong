import { resolve } from "node:path";
import { c, parseArgs } from "../util";
import { type FileFindings, scanRepoForUntranslated } from "../watch/checks";
import type { FindingKind, Untranslated } from "../watch/i18n-scan";
import { repo } from "../watch/repo";

const log = (s: string) => process.stdout.write(`${s}\n`);

const USAGE = `usage: chong check i18n [<path>] [--all] [--json]

  Scan tracked source for hardcoded, user-facing strings that aren't wrapped in
  t() — the gap pnpm i18n can't see. Prints the complete list (file:line: text)
  so you can eyeball it and tune the detector.

  <path>    limit the scan to a file or directory (default: whole repo)
  --all     include non-UI files skipped by default (scripts, tests, fixtures,
            data files, Debug* paths); .md and other non-source files are never scanned
  --json    machine-readable output

  Heuristic: a string literal / template text carrying a non-source-locale signal
  (a non-ASCII Latin letter, or a distinctive Slovenian function word) and not
  inside a t(...) call. To stay high-signal it does NOT flag strings inside a
  const object/array (data tables), console.* arguments, or Debug* paths. It also
  surfaces advisories the literal check would miss: dynamic t(variable) keys
  (invisible to extraction) and user text built by + concatenation, and marks a
  stray \\n / \\t inside copy. Still a candidate flagger — expect some noise.`;

const kindOf = (f: Untranslated): FindingKind => f.kind ?? "hardcoded";

type Row = { line: number; text: string; count: number; escape: boolean };

/** De-duplicate identical strings within a file (collapse repeats to one row, ×N). */
function dedupe(findings: Untranslated[]): Row[] {
  const seen = new Map<string, Row>();
  for (const f of findings) {
    const row = seen.get(f.text);
    if (row) {
      row.count++;
      row.line = Math.min(row.line, f.line);
      row.escape = row.escape || !!f.escape;
    } else {
      seen.set(f.text, { line: f.line, text: f.text, count: 1, escape: !!f.escape });
    }
  }
  return [...seen.values()].sort((a, b) => a.line - b.line);
}

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

  // Split every file's findings by kind: hardcoded copy is the primary report;
  // dynamic t() keys and concatenated user text are secondary advisories.
  const pick = (kind: (k: FindingKind) => boolean) =>
    results
      .map((r) => ({ ...r, findings: r.findings.filter((f) => kind(kindOf(f))) }))
      .filter((r) => r.findings.length > 0);

  const hard = pick((k) => k === "hardcoded");
  const dyn = pick((k) => k === "dynamic");
  const concat = pick((k) => k === "concat");

  const byCount = (a: FileFindings, b: FileFindings) => b.findings.length - a.findings.length;
  const ui = hard.filter((r) => r.display).sort(byCount);
  const other = hard.filter((r) => !r.display).sort(byCount);
  const countOf = (g: FileFindings[]) => g.reduce((s, r) => s + r.findings.length, 0);

  const section = (title: string, group: FileFindings[]) => {
    if (group.length === 0) return;
    log(c.bold(title));
    for (const r of group) {
      const rows = dedupe(r.findings);
      log(`${c.cyan(r.file)} ${c.dim(`(${r.findings.length})`)}`);
      for (const row of rows) {
        const esc = row.escape ? c.yellow(" ⚠ stray \\n/\\t") : "";
        const mult = row.count > 1 ? c.dim(` ×${row.count}`) : "";
        log(`  ${c.dim(`${row.line}:`)} ${row.text}${esc}${mult}`);
      }
    }
    log("");
  };

  // A flat advisory list (file → deduped rows), no display/other split.
  const advisory = (title: string, hint: string, group: FileFindings[]) => {
    if (group.length === 0) return;
    log(c.bold(title));
    log(c.dim(`  ${hint}`));
    for (const r of group.sort(byCount)) {
      log(`${c.cyan(r.file)} ${c.dim(`(${r.findings.length})`)}`);
      for (const row of dedupe(r.findings)) {
        const mult = row.count > 1 ? c.dim(` ×${row.count}`) : "";
        log(`  ${c.dim(`${row.line}:`)} ${row.text}${mult}`);
      }
    }
    log("");
  };

  section("▌ display components (.vue / UI) — prioritised", ui);
  section("▌ other files (logic / content)", other);
  advisory(
    "⚐ dynamic t() keys — invisible to extraction (pnpm i18n can't see them)",
    "give t() a string literal, or add a literal // t('…') comment so the key is extracted",
    dyn,
  );
  advisory(
    "⚐ user text built by concatenation — split copy doesn't translate cleanly",
    "use one t('… $x …').replaceAll('$x', value) instead of '…' + value + '…'",
    concat,
  );

  const hardTotal = countOf(ui) + countOf(other);
  const dynTotal = dyn.reduce((s, r) => s + r.findings.length, 0);
  const concatTotal = concat.reduce((s, r) => s + r.findings.length, 0);
  log(
    `${c.yellow(String(countOf(ui)))} in ${ui.length} display file(s)  ${c.dim("·")}  ${c.yellow(
      String(countOf(other)),
    )} in ${other.length} other file(s)  ${c.dim("·")}  ${hardTotal} hardcoded`,
  );
  if (dynTotal || concatTotal) {
    log(
      c.dim(
        `advisories: ${dynTotal} dynamic t() key(s) · ${concatTotal} concatenation(s) (listed above)`,
      ),
    );
  }
  log(c.dim("expect false positives — this is a detection feedback view, not a fix list"));
  if (!includeExcluded) {
    log(
      c.dim(
        "const data tables, console.* args, Debug* paths, scripts/tests/fixtures are skipped; pass --all to include them",
      ),
    );
  }
}
