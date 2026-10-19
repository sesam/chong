import { existsSync } from "node:fs";
import path from "node:path";
import { splitNulPaths } from "./checks";

type Run = { ok: boolean; out: string; err: string };

const LINT_GLOBS = ["*.js", "*.mjs", "*.cjs", "*.ts", "*.vue"];

export type LintError = {
  file: string;
  line: number;
  col: number;
  message: string;
  ruleId: string;
};

/**
 * JS/TS/Vue paths that differ between two refs (CI uses the same diff filter).
 *
 * `-z`: without it, `--name-only` C-quotes any path containing a space or a non-ASCII
 * character (`"a b.txt"`, `"\304\215.txt"`), and that quoted form never matches a real
 * file on disk — the file is silently dropped from the lint set instead of being linted
 * or reported. `splitNulPaths` (from `./checks`, converted the same way there) splits the
 * NUL-terminated, unquoted output.
 */
export async function lintableChangedFiles(
  git: (args: string[], cwd: string) => Promise<Run>,
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  const r = await git(
    ["diff", "--diff-filter=d", "--name-only", "-z", fromRef, toRef, "--", ...LINT_GLOBS],
    cwd,
  );
  if (!r.ok || !r.out) return [];
  return splitNulPaths(r.out)
    .map((f) => f.trim())
    .filter((f) => f && existsSync(path.join(cwd, f)));
}

/**
 * Map an oxlint diagnostic code to a rule id: `eslint(no-undef)` → `no-undef`,
 * `import(named)` → `import/named`, `lynx(i18n-t-literal)` → `lynx/i18n-t-literal`.
 */
function ruleIdFromCode(code: string): string {
  const m = code.match(/^([\w@-]+)\((.+)\)$/);
  if (!m) return code;
  return m[1] === "eslint" ? m[2] : `${m[1]}/${m[2]}`;
}

/**
 * Parse `oxlint --format json` output into error diagnostics (warnings are ignored — CI only
 * blocks errors). Unparseable output yields no errors; the caller still fails on the exit code.
 */
export function parseOxlintErrors(output: string, cwd: string): LintError[] {
  // oxlint can print a banner or warnings around the JSON document.
  const start = output.indexOf('{ "diagnostics"');
  const from = start >= 0 ? start : output.indexOf("{");
  if (from < 0) return [];
  let doc: { diagnostics?: unknown };
  try {
    doc = JSON.parse(output.slice(from, output.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  const errors: LintError[] = [];
  for (const d of (doc.diagnostics ?? []) as {
    message?: string;
    code?: string;
    severity?: string;
    filename?: string;
    labels?: { span?: { line?: number; column?: number } }[];
  }[]) {
    if (d.severity !== "error" || !d.filename) continue;
    const span = d.labels?.[0]?.span;
    errors.push({
      file: path.isAbsolute(d.filename) ? path.relative(cwd, d.filename) : d.filename,
      line: span?.line ?? 0,
      col: span?.column ?? 0,
      message: d.message ?? "",
      ruleId: ruleIdFromCode(d.code ?? ""),
    });
  }
  return errors;
}

/** Rules we can ask the coding agent to fix mechanically (missing imports, etc.). */
export function isAgentableLintRule(ruleId: string): boolean {
  return ruleId === "no-undef" || ruleId.startsWith("import/");
}

export function isAgentableLintFailure(errors: LintError[]): boolean {
  return errors.length > 0 && errors.every((e) => isAgentableLintRule(e.ruleId));
}

export function formatLintSummary(errors: LintError[]): string {
  const lines = errors
    .slice(0, 20)
    .map((e) => `${e.file}:${e.line}:${e.col}  ${e.message}  ${e.ruleId}`);
  if (errors.length > 20) lines.push(`… +${errors.length - 20} more`);
  return lines.join("\n");
}

async function sh(cmd: string[], cwd: string): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/**
 * Run oxlint on specific files the way CI does: `pnpm exec oxlint --no-error-on-unmatched-pattern`.
 * Falls back to `npx oxlint` when pnpm is unavailable. `--format json` is only used for the
 * check (not `fix`), so the agent-facing `output` stays the readable default when fixing.
 */
export async function runLint(
  cwd: string,
  files: string[],
  fix = false,
): Promise<{ ok: boolean; output: string; errors: LintError[] }> {
  if (files.length === 0) return { ok: true, output: "", errors: [] };

  const args = ["oxlint", "--no-error-on-unmatched-pattern", "--format", "json", ...files];
  if (fix) args.splice(1, 0, "--fix");

  let run: Run;
  if (Bun.which("pnpm")) {
    run = await sh(["pnpm", "exec", ...args], cwd);
  } else if (Bun.which("npx")) {
    run = await sh(["npx", ...args], cwd);
  } else {
    return { ok: false, output: "no pnpm or npx on PATH", errors: [] };
  }

  const output = `${run.out}\n${run.err}`.trim();
  const errors = parseOxlintErrors(run.out, cwd);
  return { ok: run.ok && errors.length === 0, output, errors };
}
