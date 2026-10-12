import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciVerdictFromRuns,
  effectiveTargetCmd,
  interpretStaleness,
  mergeTargets,
  parseEnvFile,
  planDeploy,
  redactValues,
  targetFromDeployScript,
  targetKeyPrefix,
  targetMarkerConfig,
  validateTargets,
} from "./deploy-targets";

const dirs: string[] = [];
function tmpRepo(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), "chong-targets-"));
  dirs.push(d);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    writeFileSync(path.join(d, f), body);
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("discovery", () => {
  test("deploy.sh at depth 1-2 becomes a target; deeper, root and hidden do not", () => {
    expect(targetFromDeployScript("render-api/deploy.sh")).toEqual({
      dir: "render-api",
      name: "render-api",
    });
    expect(targetFromDeployScript("agents/opn_agent/deploy.sh")).toEqual({
      dir: "agents/opn_agent",
      name: "agents-opn_agent",
    });
    expect(targetFromDeployScript("deploy.sh")).toBeNull();
    expect(targetFromDeployScript("a/b/c/deploy.sh")).toBeNull();
    expect(targetFromDeployScript(".github/deploy.sh")).toBeNull();
    expect(targetFromDeployScript("node_modules/x/deploy.sh")).toBeNull();
  });

  test("default paths are own dir + sharedPaths; override paths replace the dir only", () => {
    const { targets, errors } = mergeTargets(
      ["agents/a/deploy.sh", "render-api/deploy.sh"],
      [{ name: "render-api", paths: ["render-api/src"], label: "render" }],
      { sharedPaths: ["constants.py"] },
    );
    expect(errors).toEqual([]);
    const a = targets.find((t) => t.name === "agents-a");
    const r = targets.find((t) => t.name === "render-api");
    expect(a?.paths).toEqual(["agents/a", "constants.py"]);
    expect(a?.dir).toBe("agents/a");
    expect(r?.paths).toEqual(["render-api/src", "constants.py"]);
    expect(r?.label).toBe("render");
  });

  test("ignore list, explicit-cmd escape hatch, and orphan overrides", () => {
    const { targets, errors } = mergeTargets(
      ["agents/a/deploy.sh", "agents/b/deploy.sh"],
      [{ name: "custom", cmd: "./x.sh" }, { name: "ghost" }],
      { ignore: ["agents-b"] },
    );
    expect(targets.map((t) => t.name)).toEqual(["agents-a", "custom"]);
    expect(errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  test("a bad directory name is reported, not silently dropped", () => {
    const { targets, errors } = mergeTargets(["Agents/Foo/deploy.sh"], []);
    expect(targets).toEqual([]);
    expect(errors[0]).toContain("must match");
  });
});

describe("validateTargets", () => {
  test("rejects shell metacharacters, bad names, escaping paths", () => {
    const { targets, errors } = validateTargets([
      { name: "ok", cmd: "bash deploy.sh" },
      { name: "bad cmd", cmd: "x" },
      { name: "inj", cmd: "x; rm -rf /" },
      { name: "esc", cmd: "x", paths: ["../outside"] },
      { name: "env", cmd: "x", envFile: "/etc/passwd" },
      { name: "ok" },
      { name: "verify", verifyCmd: "curl $(x)" },
    ]);
    expect(targets.map((t) => t.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(6);
  });

  test("accepts an object keyed by target name", () => {
    const { targets, errors } = validateTargets({
      "agents-a": { label: "production", paths: ["agents/a/"] },
    });
    expect(errors).toEqual([]);
    expect(targets[0]).toMatchObject({ name: "agents-a", label: "production" });
  });

  test("auto defaults to off", () => {
    expect(validateTargets([{ name: "a", cmd: "x" }]).targets[0].auto).toBeUndefined();
    expect(validateTargets([{ name: "a", cmd: "x", auto: true }]).targets[0].auto).toBe(true);
  });
});

describe("env file", () => {
  test("parses quotes, export, comments; never evaluates", () => {
    const env = parseEnvFile(
      ["# c", "A=1", 'export B="x y\\n"', "C='$(boom)'", "D=plain # trailing", "bad line", ""].join(
        "\n",
      ),
    );
    expect(env).toEqual({ A: "1", B: "x y\n", C: "$(boom)", D: "plain" });
  });
  test("redacts values of 6+ chars", () => {
    expect(redactValues("token=abcdef123 ok=1", { T: "abcdef123", S: "1" })).toBe("token=*** ok=1");
  });
});

describe("staleness", () => {
  test("never deployed / incomparable / changed / fresh", () => {
    expect(interpretStaleness(null, { ok: true, out: "" }).reason).toBe("never deployed");
    expect(interpretStaleness("abc1234", { ok: false, out: "" }).stale).toBe(true);
    expect(interpretStaleness("abc1234", { ok: true, out: "a\nb" })).toMatchObject({
      stale: true,
      reason: "2 changed files",
    });
    expect(interpretStaleness("abc1234", { ok: true, out: "" }).stale).toBe(false);
  });
});

describe("gate", () => {
  test("ci verdict mirrors ci_result_for_sha.sh", () => {
    expect(ciVerdictFromRuns(["completed/failure", "completed/success"])).toBe("success");
    expect(ciVerdictFromRuns(["in_progress/", "completed/failure"])).toBe("pending");
    expect(ciVerdictFromRuns(["completed/failure"])).toBe("failure");
    expect(ciVerdictFromRuns(["completed/cancelled"])).toBe("none");
    expect(ciVerdictFromRuns([])).toBe("none");
  });

  const base = {
    checks: { ok: true, summary: "" },
    ci: "success" as const,
    onRemote: true,
    forceGate: false,
  };
  test("allows a green, remote commit", () => {
    expect(planDeploy(base).allow).toBe(true);
  });
  test("refuses failing checks, red CI, and unpushed commits", () => {
    expect(planDeploy({ ...base, checks: { ok: false, summary: "ruff" } }).allow).toBe(false);
    expect(planDeploy({ ...base, ci: "failure" }).allow).toBe(false);
    expect(planDeploy({ ...base, onRemote: false }).allow).toBe(false);
  });
  test("--force-gate bypasses checks/CI but never the on-remote rule", () => {
    const forced = planDeploy({ ...base, ci: "failure", forceGate: true });
    expect(forced.allow).toBe(true);
    expect(forced.warnings[0]).toContain("bypassed");
    expect(planDeploy({ ...base, onRemote: false, forceGate: true }).allow).toBe(false);
  });
  test("no checks and no CI warns but allows", () => {
    const p = planDeploy({ ...base, checks: null, ci: "none" });
    expect(p.allow).toBe(true);
    expect(p.warnings).toHaveLength(1);
  });
});

describe("marker bucket + effective command", () => {
  test("prefix defaults to <repoDirName>/ and keys are per target", () => {
    const d = tmpRepo({
      ".chong/config.json": JSON.stringify({ targetMarkerBucket: "my-markers" }),
    });
    const m = targetMarkerConfig(d);
    expect(m?.bucket).toBe("my-markers");
    expect(m?.prefix).toBe(`${path.basename(d)}/`);
    expect(targetKeyPrefix("r/", "agents-a")).toBe("r/agents-a/");
    expect(() => targetKeyPrefix("r/", "../x")).toThrow();
  });
  test("invalid bucket or prefix is refused", () => {
    expect(
      targetMarkerConfig(
        tmpRepo({ ".chong/config.json": JSON.stringify({ targetMarkerBucket: "BAD_Bucket" }) }),
      ),
    ).toBeNull();
    expect(
      targetMarkerConfig(
        tmpRepo({
          ".chong/config.json": JSON.stringify({
            targetMarkerBucket: "ok-bucket",
            targetMarkerPrefix: "../x",
          }),
        }),
      ),
    ).toBeNull();
  });
  test("uv python repos run deploy.sh through uv; others use plain bash; cmd wins", () => {
    const py = tmpRepo({ "pyproject.toml": "[project]\nname='x'\n", "uv.lock": "" });
    expect(effectiveTargetCmd(py, { name: "a", dir: "a" })).toBe(
      "uv run --frozen --no-sync bash deploy.sh",
    );
    expect(effectiveTargetCmd(py, { name: "a", cmd: "./x.sh" })).toBe("./x.sh");
    const plain = tmpRepo({ "README.md": "" });
    expect(effectiveTargetCmd(plain, { name: "a", dir: "a" })).toBe("bash deploy.sh");
  });
});
