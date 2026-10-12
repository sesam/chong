import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchesAnyGlob, splitArgv } from "./repo-config";
import { detectRepoProfile } from "./repo-profile";
import { anyFailed, runChecks } from "./run-checks";

function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chong-profile-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("globs / argv", () => {
  test("basename and ** globs", () => {
    expect(matchesAnyGlob("agents/x/a.py", ["**/*.py"])).toBe(true);
    expect(matchesAnyGlob("a.py", ["**/*.py"])).toBe(true);
    expect(matchesAnyGlob("a.py", ["*.py"])).toBe(true);
    expect(matchesAnyGlob("agents/a.py", ["*.py"])).toBe(true);
    expect(matchesAnyGlob("agents/a.js", ["**/*.py"])).toBe(false);
    expect(matchesAnyGlob("pyproject.toml", ["pyproject.toml"])).toBe(true);
    expect(matchesAnyGlob("anything", undefined)).toBe(true);
  });
  test("splitArgv honours quotes", () => {
    expect(splitArgv('pytest -q -m "not integration"')).toEqual([
      "pytest",
      "-q",
      "-m",
      "not integration",
    ]);
  });
});

describe("detectRepoProfile", () => {
  test("package.json keeps the pnpm defaults and all steps", () => {
    const p = detectRepoProfile(tmpRepo({ "package.json": "{}" }));
    expect(p.kind).toBe("node");
    expect(p.formatCmd).toBe("pnpm format");
    expect(p.testCmd).toBe("pnpm test");
    expect(Object.values(p.supports).every(Boolean)).toBe(true);
    expect(p.checks).toEqual([]);
  });
  test("pyproject with ruff gives ruff lint+format checks, no pnpm steps", () => {
    const p = detectRepoProfile(tmpRepo({ "pyproject.toml": "[tool.ruff]\nline-length=100\n" }));
    expect(p.kind).toBe("python");
    expect(p.checks.map((c) => c.name)).toEqual(["ruff lint", "ruff format"]);
    expect(p.checks.every((c) => c.cmd.includes("--force-exclude"))).toBe(true);
    expect(p.formatCmd).toContain("ruff format");
    expect(Object.values(p.supports).some(Boolean)).toBe(false);
    expect(p.shadowLinks).toContain(".venv");
  });
  test("configured checks win and unsafe ones are dropped", () => {
    const p = detectRepoProfile(
      tmpRepo({
        "pyproject.toml": "[tool.ruff]\n",
        ".chong/config.json": JSON.stringify({
          checks: [
            { name: "ok", cmd: "true" },
            { name: "evil", cmd: "true; rm -rf /" },
          ],
        }),
      }),
    );
    expect(p.checks.map((c) => c.name)).toEqual(["ok"]);
  });
  test("plain dir is generic", () => {
    expect(detectRepoProfile(tmpRepo({ "README.md": "" })).kind).toBe("generic");
  });
});

describe("runChecks", () => {
  const repo = tmpRepo({});
  test("skips when no file matches, passes/fails otherwise, honours phases", async () => {
    const checks = [
      { name: "py", cmd: "echo", scope: "files" as const, match: ["**/*.py"] },
      { name: "bad", cmd: "false", scope: "repo" as const },
      { name: "deploy-only", cmd: "false", phases: ["deploy" as const] },
    ];
    const r = await runChecks(repo, checks, { files: ["x.js"], phase: "commit" });
    expect(r.map((x) => x.status)).toEqual(["skipped", "fail"]);
    expect(anyFailed(r)).toBe(true);
    const ok = await runChecks(repo, [checks[0]], { files: ["a/b.py"], phase: "commit" });
    expect(ok[0].status).toBe("pass");
    expect(ok[0].ran).toBe("echo a/b.py");
    const whole = await runChecks(repo, [checks[0]], { phase: "deploy" });
    expect(whole[0].ran).toBe("echo .");
  });
  test("a missing tool is a failure, not a throw", async () => {
    const r = await runChecks(repo, [{ name: "x", cmd: "definitely-not-a-binary-xyz" }], {
      phase: "deploy",
    });
    expect(r[0].status).toBe("fail");
  });
});
