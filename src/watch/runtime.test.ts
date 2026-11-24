import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoundedSet,
  WatchLogger,
  deployAwsEnv,
  readStreamCapped,
  registerShutdownHook,
  runAllShutdownHooks,
  setDeployAwsProfile,
} from "./runtime";

const dirs: string[] = [];
afterEach(() => {
  setDeployAwsProfile(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("BoundedSet", () => {
  test("evicts oldest entries in FIFO order once maxSize is exceeded", () => {
    const s = new BoundedSet<string>(3);
    s.add("a").add("b").add("c");
    expect([...s]).toEqual(["a", "b", "c"]);
    s.add("b"); // duplicate does not evict
    expect([...s]).toEqual(["a", "b", "c"]);
    s.add("d");
    expect([...s]).toEqual(["b", "c", "d"]);
    expect(s.has("a")).toBe(false);
    expect(s.size).toBe(3);
  });
});

describe("readStreamCapped", () => {
  test("caps retained memory to tail while streaming full output to logFd", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-stream-"));
    dirs.push(dir);
    const logPath = path.join(dir, "out.log");
    const fd = openSync(logPath, "w", 0o600);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("AAAA-1111\n"));
        controller.enqueue(enc.encode("BBBB-2222\n"));
        controller.enqueue(enc.encode("CCCC-3333\n"));
        controller.close();
      },
    });
    const text = await readStreamCapped(stream, 12, fd);
    closeSync(fd);

    expect(text).toContain("truncated");
    expect(text).toContain("CCCC-3333");
    expect(text).not.toContain("AAAA-1111");
    // Full untruncated stream landed on disk.
    expect(readFileSync(logPath, "utf8")).toBe("AAAA-1111\nBBBB-2222\nCCCC-3333\n");
  });
});

describe("WatchLogger", () => {
  test("writes ANSI-stripped timestamped lines to persistent log file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-log-"));
    dirs.push(dir);
    const filePath = path.join(dir, "watch.log");
    const logger = new WatchLogger({ filePath });
    logger.log("warn", "\x1b[33m⚠ deploy deferred\x1b[0m\nsecond line");
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("[warn] ⚠ deploy deferred | second line");
    expect(content).not.toContain("\x1b[");
  });
});

describe("deployAwsEnv", () => {
  test("overrides AWS_PROFILE and strips ambient static keys when scoped profile is set", () => {
    setDeployAwsProfile("chong-deploy-only");
    const env = deployAwsEnv({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "AKIA_PERSONAL",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "tok",
    });
    expect(env.AWS_PROFILE).toBe("chong-deploy-only");
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });
});

describe("ShutdownRegistry", () => {
  test("runs sync and async cleanup hooks and respects timeout bound", async () => {
    const order: string[] = [];
    const unreg1 = registerShutdownHook({
      sync: () => order.push("sync-1"),
      async: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("async-1");
      },
    });
    const unreg2 = registerShutdownHook({
      sync: () => order.push("never"),
    });
    unreg2(); // unregistered hook must not run

    await runAllShutdownHooks(500);
    unreg1();
    expect(order).toEqual(["sync-1", "async-1"]);
  });
});
