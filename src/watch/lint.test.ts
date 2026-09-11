import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatLintSummary,
  isAgentableLintFailure,
  isAgentableLintRule,
  lintableChangedFiles,
  parseEslintErrors,
} from "./lint";

describe("parseEslintErrors", () => {
  test("extracts error lines and ignores warnings", () => {
    const out = [
      "src/layouts/useAppNavItems.js",
      "  75:16  error  'tJournal' is not defined  no-undef",
      "  82:16  error  'tJournal' is not defined  no-undef",
      "  10:1   warning  Unexpected console statement  no-console",
    ].join("\n");
    const errors = parseEslintErrors(out, "/repo");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      file: "src/layouts/useAppNavItems.js",
      line: 75,
      ruleId: "no-undef",
    });
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
    const allAgentable = parseEslintErrors(
      "f.js\n  1:1  error  'x' is not defined  no-undef",
      ".",
    );
    const mixed = parseEslintErrors(
      "f.js\n  1:1  error  'x' is not defined  no-undef\n  2:1  error  bad  no-console",
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
