import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultStageDeployCmd,
  ensureChongIgnored,
  loadRepoDeployConfig,
  stageDeployedShaBucket,
} from "./stage-deploy";

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), "chong-repo-"));
}
function withChong(dir: string, cfg: unknown): void {
  mkdirSync(path.join(dir, ".chong"), { recursive: true });
  writeFileSync(path.join(dir, ".chong", "config.json"), JSON.stringify(cfg));
}
function asFrontend(dir: string): void {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "deploy-frontend.sh"), "#!/bin/sh\n");
}

describe("stageDeployedShaBucket — the cross-repo hazard", () => {
  test("is null for a repo that configured no bucket", () => {
    // The bug this closes: the bucket was a module constant and the marker was written
    // unconditionally, so watching a second repo overwrote FRONTEND's deployed-git-sha.txt
    // with the other repo's SHA — and FRONTEND's stage CI reads that marker to decide
    // whether it can no-op, so it would skip a deploy it should have run.
    expect(stageDeployedShaBucket(repo())).toBeNull();
  });

  test("uses the repo's own bucket when configured", () => {
    const dir = repo();
    withChong(dir, { stageDeployedShaBucket: "some-other-bucket" });
    expect(stageDeployedShaBucket(dir)).toBe("some-other-bucket");
  });

  test("does NOT sniff a bucket from the presence of a deploy script", () => {
    // Removed 2026-09-10: this used to return a hardcoded LynxCraft bucket for any
    // repo containing scripts/deploy-frontend.sh. That shipped one project's
    // infrastructure name inside chong, and would write that project's marker on
    // behalf of an unrelated repo that merely had a similarly-named script. The
    // repo declares its own bucket now (FRONTEND does, in .chong/config.json).
    const dir = repo();
    asFrontend(dir);
    expect(stageDeployedShaBucket(dir)).toBeNull();
  });

  test("a configured bucket is used even for a repo with a deploy script", () => {
    const dir = repo();
    asFrontend(dir);
    withChong(dir, { stageDeployedShaBucket: "explicit" });
    expect(stageDeployedShaBucket(dir)).toBe("explicit");
  });
});

describe("defaultStageDeployCmd", () => {
  test("prefers .chong/config.json over everything", () => {
    const dir = repo();
    asFrontend(dir);
    withChong(dir, { stageDeployCmd: "make ship" });
    expect(defaultStageDeployCmd(dir)).toBe("make ship");
  });

  test("falls back to the repo's own deploy:stage script", () => {
    const dir = repo();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { "deploy:stage": "serverless deploy --stage stage" } }),
    );
    expect(defaultStageDeployCmd(dir)).toBe("npm run deploy:stage");
  });

  test("is null when the repo says nothing about deploying", () => {
    // Must stay null rather than guessing: a wrong deploy command is worse than none.
    const dir = repo();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(defaultStageDeployCmd(dir)).toBeNull();
  });

  test("survives a malformed config and package.json rather than crashing the TUI", () => {
    const dir = repo();
    mkdirSync(path.join(dir, ".chong"), { recursive: true });
    writeFileSync(path.join(dir, ".chong", "config.json"), "{ not json");
    writeFileSync(path.join(dir, "package.json"), "{ also not json");
    expect(loadRepoDeployConfig(dir)).toEqual({});
    expect(defaultStageDeployCmd(dir)).toBeNull();
  });
});

describe("ensureChongIgnored", () => {
  test("creates .chong and ignores it", () => {
    const dir = repo();
    ensureChongIgnored(dir);
    expect(existsSync(path.join(dir, ".chong"))).toBe(true);
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".chong/");
  });

  test("ignores machine-local state but NOT config.json", () => {
    // .chong holds two kinds of thing. state.json / stage-deployed-sha / wt/ are
    // machine-local; config.json is deliberate per-repo configuration, and a blanket
    // ignore would mean every fresh clone silently loses the deploy command and marker
    // bucket.
    const dir = repo();
    ensureChongIgnored(dir);
    const out = readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(out).toContain(".chong/");
    expect(out).toContain("!.chong/config.json");
    // The negation must come after the ignore, or git does not apply it.
    expect(out.indexOf("!.chong/config.json")).toBeGreaterThan(out.indexOf(".chong/"));
  });

  test("appends without clobbering an existing .gitignore", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\ndist\n");
    ensureChongIgnored(dir);
    const out = readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(out).toContain("node_modules");
    expect(out).toContain("dist");
    expect(out).toContain(".chong/");
  });

  test("is idempotent and does not re-append", () => {
    const dir = repo();
    ensureChongIgnored(dir);
    ensureChongIgnored(dir);
    ensureChongIgnored(dir);
    // Count the exact ignore LINE, not the substring: `!.chong/config.json` also
    // contains ".chong/", which made a substring count read 2 and look like a re-append.
    const lines = readFileSync(path.join(dir, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    // `.chong/*`, not `.chong/` — see ensureChongIgnored. The "already covered"
    // check must recognise the exact form it writes, or every run re-appends.
    expect(lines.filter((l) => l === ".chong/*")).toHaveLength(1);
    expect(lines.filter((l) => l === "!.chong/config.json")).toHaveLength(1);
  });

  test("respects an existing rule written any of the usual ways", () => {
    for (const rule of [".chong", ".chong/", "/.chong", "/.chong/"]) {
      const dir = repo();
      writeFileSync(path.join(dir, ".gitignore"), `${rule}\n`);
      ensureChongIgnored(dir);
      const out = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(out.trim()).toBe(rule);
    }
  });

  test("adds a trailing newline before appending to a file that lacks one", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "dist");
    ensureChongIgnored(dir);
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).not.toContain("dist#");
  });
});
