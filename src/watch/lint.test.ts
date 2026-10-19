import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatLintSummary,
  isAgentableLintFailure,
  isAgentableLintRule,
  lintableChangedFiles,
  parseOxlintErrors,
} from "./lint";

const diag = (code: string, severity = "error", filename = "src/a.js") => ({
  message: "msg",
  code,
  severity,
  filename,
  labels: [{ span: { offset: 0, length: 1, line: 75, column: 16 } }],
});

describe("parseOxlintErrors", () => {
  test("extracts error diagnostics, maps rule ids and ignores warnings", () => {
    const out = JSON.stringify({
      diagnostics: [
        diag("eslint(no-undef)", "error", "/repo/src/layouts/useAppNavItems.js"),
        diag("import(named)"),
        diag("lynx(i18n-t-literal)"),
        diag("eslint(no-console)", "warning"),
      ],
      number_of_files: 3,
    });
    const errors = parseOxlintErrors(`banner\n${out}\n`, "/repo");
    expect(errors.map((e) => e.ruleId)).toEqual([
      "no-undef",
      "import/named",
      "lynx/i18n-t-literal",
    ]);
    expect(errors[0]).toMatchObject({ file: "src/layouts/useAppNavItems.js", line: 75, col: 16 });
  });

  test("returns no errors for unparseable output", () => {
    expect(parseOxlintErrors("not json", ".")).toEqual([]);
  });
});

describe("isAgentableLintRule", () => {
  test("treats no-undef and import/* as agentable", () => {
    expect(isAgentableLintRule("no-undef")).toBe(true);
    expect(isAgentableLintRule("import/no-unresolved")).toBe(true);
    expect(isAgentableLintRule("no-console")).toBe(false);
  });
});

describe("isAgentableLintFailure", () => {
  test("requires every error to be agentable", () => {
    const allAgentable = parseOxlintErrors(
      JSON.stringify({ diagnostics: [diag("eslint(no-undef)")] }),
      ".",
    );
    const mixed = parseOxlintErrors(
      JSON.stringify({ diagnostics: [diag("eslint(no-undef)"), diag("eslint(no-empty)")] }),
      ".",
    );
    expect(isAgentableLintFailure(allAgentable)).toBe(true);
    expect(isAgentableLintFailure(mixed)).toBe(false);
  });
});

describe("lintableChangedFiles — quoted-path files must not be silently dropped", () => {
  // Without `-z`, `git diff --name-only` C-quotes a path containing a space or a
  // non-ASCII character ("a b.ts", "\304\215.ts"), and that quoted form never matches a
  // real file on disk — the file is excluded from linting without any error. `-z` +
  // `splitNulPaths` returns the raw, unquoted path instead.

  function repoDir(): string {
    return mkdtempSync(path.join(tmpdir(), "chong-lint-"));
  }

  test("a space-bearing path arrives unquoted and passes the existsSync filter", async () => {
    const dir = repoDir();
    writeFileSync(path.join(dir, "a b.ts"), "export const x = 1;\n");

    const fakeGit = async (args: string[]) => {
      expect(args).toContain("-z");
      // What `git diff --name-only -z` actually emits: raw path + trailing NUL, unquoted.
      return { ok: true, out: "a b.ts\0", err: "" };
    };

    const files = await lintableChangedFiles(fakeGit, dir, "HEAD~1", "HEAD");
    expect(files).toEqual(["a b.ts"]);
  });

  test("a non-ASCII path arrives unquoted and passes the existsSync filter", async () => {
    const dir = repoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "č.ts"), "export const x = 1;\n");

    const fakeGit = async () => ({ ok: true, out: "č.ts\0", err: "" });

    const files = await lintableChangedFiles(fakeGit, dir, "HEAD~1", "HEAD");
    expect(files).toEqual(["č.ts"]);
  });

  test("multiple NUL-separated files split correctly", async () => {
    const dir = repoDir();
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "b.ts"), "export const b = 1;\n");

    const fakeGit = async () => ({ ok: true, out: "a.ts\0b.ts\0", err: "" });

    const files = await lintableChangedFiles(fakeGit, dir, "HEAD~1", "HEAD");
    expect(files).toEqual(["a.ts", "b.ts"]);
  });
});

describe("formatLintSummary", () => {
  test("formats a compact multi-line summary", () => {
    const s = formatLintSummary([
      { file: "a.js", line: 1, col: 2, message: "'x' is not defined", ruleId: "no-undef" },
    ]);
    expect(s).toContain("a.js:1:2");
    expect(s).toContain("no-undef");
  });
});
