import { describe, expect, test } from "bun:test";
import {
  formatLintSummary,
  isAgentableLintFailure,
  isAgentableLintRule,
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

describe("formatLintSummary", () => {
  test("formats a compact multi-line summary", () => {
    const s = formatLintSummary([
      { file: "a.js", line: 1, col: 2, message: "'x' is not defined", ruleId: "no-undef" },
    ]);
    expect(s).toContain("a.js:1:2");
    expect(s).toContain("no-undef");
  });
});
