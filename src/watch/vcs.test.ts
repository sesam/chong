import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectVcs, listTrackedFiles, parseAkkLog, parseAkkStatus, parseAkkTags } from "./vcs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("akk VCS detection and parsers", () => {
  test("detects .akk/config.json workspaces from nested subdirectories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "chong-akk-"));
    dirs.push(root);
    mkdirSync(path.join(root, ".akk"), { recursive: true });
    mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    writeFileSync(
      path.join(root, ".akk", "config.json"),
      JSON.stringify({ repo: "my-akk-app", base: "a".repeat(64) }),
    );

    const found = detectVcs(path.join(root, "src", "deep"));
    expect(found).toEqual({ kind: "akk", root, akkRepo: "my-akk-app" });
  });

  test("parseAkkStatus parses base, trunk, behind flag, and M/A/D file changes", () => {
    const st = parseAkkStatus(
      "my-app base=abcdef0123 trunk=9876543210  (behind: akk pull)\n  M src/app.ts\n  A src/new.ts\n  D old.ts\n",
    );
    expect(st).toEqual({
      repo: "my-app",
      base: "abcdef0123",
      trunk: "9876543210",
      behind: true,
      changes: [
        { status: "M", path: "src/app.ts" },
        { status: "A", path: "src/new.ts" },
        { status: "D", path: "old.ts" },
      ],
    });
  });

  test("parseAkkLog parses tagged & untagged commits and sanitizes terminal escapes", () => {
    const raw = [
      "abcdef0123 (current-stage, prod-1)  2026-11-24 09:10  simon  fix\x1b[31m login",
      "1234567890  2026-11-23 18:02  ana  add tests",
    ].join("\n");
    const commits = parseAkkLog(raw);
    expect(commits.length).toBe(2);
    expect(commits[0].short).toBe("abcdef0");
    expect(commits[0].author).toBe("simon");
    expect(commits[0].subject).not.toContain("\x1b");
    expect(commits[0].iso).toBe("2026-11-24T09:10:00Z");
    expect(commits[1].sha).toBe("1234567890");
  });

  test("parseAkkTags parses tag map", () => {
    const tags = parseAkkTags("current-stage abcdef0123\ncurrent-prod 1234567890\n");
    expect(tags.get("current-stage")).toBe("abcdef0123");
    expect(tags.get("current-prod")).toBe("1234567890");
  });

  test("listTrackedFiles skips .akk, node_modules, and dist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "chong-akk-files-"));
    dirs.push(root);
    mkdirSync(path.join(root, ".akk"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, ".akk", "config.json"), "{}");
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "");
    writeFileSync(path.join(root, "src", "main.ts"), "export const x = 1;\n");

    const files = await listTrackedFiles(root);
    expect(files).toEqual(["src/main.ts"]);
  });
});
