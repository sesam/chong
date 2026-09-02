import { existsSync } from "node:fs";
import path from "node:path";

type Run = { ok: boolean; out: string; err: string };

const LINT_GLOBS = ["*.js", "*.mjs", "*.cjs", "*.ts", "*.vue"];

export type EslintError = {
  file: string;
  line: number;
  col: number;
  message: string;
  ruleId: string;
};

/** JS/TS/Vue paths that differ between two refs (CI uses the same diff filter). */
export async function lintableChangedFiles(
  git: (args: string[], cwd: string) => Promise<Run>,
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  const r = await git(
    ["diff", "--diff-filter=d", "--name-only", fromRef, toRef, "--", ...LINT_GLOBS],
    cwd,
  );
  if (!r.ok || !r.out) return [];
  return r.out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f && existsSync(path.join(cwd, f)));
}

/** Parse `eslint` stdout/stderr for error lines (warnings are ignored — CI only blocks errors). */
export function parseEslintErrors(output: string, cwd: string): EslintError[] {
  const errors: EslintError[] = [];
  let currentFile = "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("/") || /^[\w@./-]+\.(js|mjs|cjs|ts|vue)$/.test(line.trim())) {
      const raw = line.trim();
      currentFile = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw;
      continue;
    }
    const m = line.match(/^\s+(\d+):(\d+)\s+error\s+(.+?)\s+([\w@/-]+)\s*$/);
    if (!m || !currentFile) continue;
    errors.push({
      file: currentFile,
      line: Number.parseInt(m[1], 10),
      col: Number.parseInt(m[2], 10),
      message: m[3],
      ruleId: m[4],
    });
  }
  return errors;
}

/** Rules we can ask the coding agent to fix mechanically (missing imports, etc.). */
export function isAgentableLintRule(ruleId: string): boolean {
  return ruleId === "no-undef" || ruleId.startsWith("import/");
}

export function isAgentableLintFailure(errors: EslintError[]): boolean {
  return errors.length > 0 && errors.every((e) => isAgentableLintRule(e.ruleId));
}

export function formatLintSummary(errors: EslintError[]): string {
  const lines = errors.slice(0, 20).map((e) => `${e.file}:${e.line}:${e.col}  ${e.message}  ${e.ruleId}`);
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
 * Run eslint on specific files the way CI does: `pnpm exec eslint --no-error-on-unmatched-pattern`.
 * Falls back to `npx eslint` when pnpm is unavailable.
 */
export async function runEslint(
  cwd: string,
  files: string[],
  fix = false,
): Promise<{ ok: boolean; output: string; errors: EslintError[] }> {
  if (files.length === 0) return { ok: true, output: "", errors: [] };

  const eslintArgs = ["eslint", "--no-error-on-unmatched-pattern", ...files];
  if (fix) eslintArgs.splice(1, 0, "--fix");

  let run: Run;
  if (Bun.which("pnpm")) {
    run = await sh(["pnpm", "exec", ...eslintArgs], cwd);
  } else if (Bun.which("npx")) {
    run = await sh(["npx", ...eslintArgs], cwd);
  } else {
    return { ok: false, output: "no pnpm or npx on PATH", errors: [] };
  }

  const output = `${run.out}\n${run.err}`.trim();
  const errors = parseEslintErrors(output, cwd);
  return { ok: run.ok && errors.length === 0, output, errors };
}
