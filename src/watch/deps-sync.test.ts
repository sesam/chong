import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureShadowDepsSynced, readDepsSyncState } from "./deps-sync";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makePair() {
  const root = mkdtempSync(path.join(tmpdir(), "chong-deps-sync-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  const shadow = path.join(root, "shadow");
  mkdirSync(repo, { recursive: true });
  mkdirSync(shadow, { recursive: true });
  return { repo, shadow };
}

describe("ensureShadowDepsSynced", () => {
  test("syncs repo node_modules when lockfile is new or changed, then no-ops on match", async () => {
    const { repo, shadow } = makePair();
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# v1\n");
    writeFileSync(path.join(shadow, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# v1\n");
    mkdirSync(path.join(repo, "node_modules"));

    const calls: Array<{ cmd: string[]; cwd: string }> = [];
    const installer = async (cmd: string[], cwd: string) => {
      calls.push({ cmd, cwd });
      return { ok: true, err: "" };
    };

    const r1 = await ensureShadowDepsSynced(repo, shadow, {
      installer,
      hasBin: (b) => b === "pnpm",
    });
    expect(r1.action).toBe("synced-repo");
    expect(calls).toEqual([{ cmd: ["pnpm", "install", "--frozen-lockfile"], cwd: repo }]);
    expect(readDepsSyncState(repo).pnpmLockHash).toBeTruthy();

    // Second call with unchanged lockfile is a fast no-op.
    const r2 = await ensureShadowDepsSynced(repo, shadow, {
      installer,
      hasBin: (b) => b === "pnpm",
    });
    expect(r2.action).toBe("noop");
    expect(calls.length).toBe(1);

    // Changing lockfile triggers a fresh sync.
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# v2\n");
    writeFileSync(path.join(shadow, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# v2\n");
    const r3 = await ensureShadowDepsSynced(repo, shadow, {
      installer,
      hasBin: (b) => b === "pnpm",
    });
    expect(r3.action).toBe("synced-repo");
    expect(calls.length).toBe(2);
  });

  test("diverged shadow lockfile unlinks shadow symlink and installs inside shadow only", async () => {
    const { repo, shadow } = makePair();
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# old\n");
    writeFileSync(path.join(shadow, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# new\n");
    mkdirSync(path.join(repo, "node_modules"));
    symlinkSync(path.join(repo, "node_modules"), path.join(shadow, "node_modules"));

    const calls: Array<{ cmd: string[]; cwd: string }> = [];
    const r = await ensureShadowDepsSynced(repo, shadow, {
      allowShadowInstall: true,
      installer: async (cmd, cwd) => {
        calls.push({ cmd, cwd });
        mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
        return { ok: true, err: "" };
      },
      hasBin: (b) => b === "pnpm",
    });

    expect(r.action).toBe("synced-shadow");
    expect(calls).toEqual([{ cmd: ["pnpm", "install", "--frozen-lockfile"], cwd: shadow }]);
    expect(existsSync(path.join(repo, "node_modules"))).toBe(true);
    expect(lstatSync(path.join(shadow, "node_modules")).isSymbolicLink()).toBe(false);
  });

  test("syncs Python uv.lock / .venv when uv is present", async () => {
    const { repo, shadow } = makePair();
    writeFileSync(path.join(repo, "uv.lock"), "version = 1\n");
    writeFileSync(path.join(shadow, "uv.lock"), "version = 1\n");
    mkdirSync(path.join(repo, ".venv"));

    const calls: string[][] = [];
    const r = await ensureShadowDepsSynced(repo, shadow, {
      installer: async (cmd) => {
        calls.push(cmd);
        return { ok: true, err: "" };
      },
      hasBin: (b) => b === "uv",
    });
    expect(r.action).toBe("synced-repo");
    expect(calls).toEqual([["uv", "sync", "--frozen"]]);
  });
});
