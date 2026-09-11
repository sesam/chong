import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAIM_STALE_MS,
  type DeployClaim,
  acquireDeployClaim,
  formatClaimHolder,
  formatDeployClaim,
  isClaimStale,
  makeDeployClaim,
  parseDeployClaim,
  readDeployClaim,
  releaseDeployClaim,
} from "./deploy-claim";
import {
  WORKTREE_CLAIM_STALE_MS,
  acquireWorktreeClaim,
  isWorktreeClaimActive,
  readWorktreeClaim,
  releaseWorktreeClaim,
  worktreeOwnerPath,
} from "./worktree-claim";

describe("deploy-claim parse/format", () => {
  const pid = "11111111-1111-1111-1111-111111111111";

  test("round-trips a claim bound to a process id", () => {
    const claim = makeDeployClaim("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pid);
    expect(claim.id).toBe(pid);
    const again = parseDeployClaim(formatDeployClaim(claim));
    expect(again).toEqual(claim);
  });

  test("rejects garbage and empty", () => {
    expect(parseDeployClaim("")).toBeNull();
    expect(parseDeployClaim("not-json")).toBeNull();
    expect(parseDeployClaim('{"v":2,"id":"x"}')).toBeNull();
  });

  test("stale after 20 minutes", () => {
    const fresh = makeDeployClaim("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pid);
    expect(isClaimStale(fresh)).toBe(false);
    const old = {
      ...fresh,
      at: new Date(Date.now() - CLAIM_STALE_MS - 1_000).toISOString(),
    };
    expect(isClaimStale(old)).toBe(true);
  });

  test("formatClaimHolder includes user and short sha", () => {
    const s = formatClaimHolder({
      v: 1,
      id: pid,
      user: "simon",
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      at: "2026-09-10T12:00:00.000Z",
      host: "mbp",
    });
    expect(s).toContain("simon@mbp");
    expect(s).toContain("abcdef0");
  });

  test("parseDeployClaim strips ANSI escapes and control chars from user/host", () => {
    const dirtyUser = "simon[31m[2Jpwned";
    const dirtyHost = "mbp]0;evil\r\n";
    const raw = JSON.stringify({
      v: 1,
      id: pid,
      user: dirtyUser,
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      at: "2026-09-10T12:00:00.000Z",
      host: dirtyHost,
    });
    const claim = parseDeployClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;
    // biome-ignore lint: matching control-char detection to the sanitizer's own set
    const controlOrEscape = /[\x00-\x1f\x7f]/;
    expect(controlOrEscape.test(claim.user)).toBe(false);
    expect(controlOrEscape.test(claim.host ?? "")).toBe(false);
    expect(claim.user).toContain("simon");
    expect(claim.user).toContain("pwned");
    expect(claim.host).toContain("mbp");
    // ownership never keys off these fields — only `id` does.
    expect(claim.id).toBe(pid);
  });

  test("parseDeployClaim caps absurdly long user/host fields", () => {
    const raw = JSON.stringify({
      v: 1,
      id: pid,
      user: "x".repeat(500),
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      at: "2026-09-10T12:00:00.000Z",
      host: "y".repeat(500),
    });
    const claim = parseDeployClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;
    expect(claim.user.length).toBeLessThanOrEqual(64);
    expect((claim.host ?? "").length).toBeLessThanOrEqual(64);
  });
});

/**
 * In-memory stand-in for the marker bucket, keyed by `s3://bucket/key`. Swaps in for
 * `Bun.spawn` so `acquireDeployClaim` / `readDeployClaim` / `releaseDeployClaim` never
 * shell out to the real `aws` CLI.
 */
function stubAwsS3(store: Map<string, string>) {
  return spyOn(Bun, "spawn").mockImplementation(((
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    const [, , action, ...rest] = args;
    if (action === "cp" && rest[0] === "-") {
      // write: aws s3 cp - s3://bucket/key ...
      const uri = rest[1] as string;
      const exited = (async () => {
        const body = await new Response(opts.stdin as Blob).text();
        store.set(uri, body);
        return 0;
      })();
      return { exited, stdout: new Response("").body, stderr: new Response("").body };
    }
    if (action === "cp") {
      // read: aws s3 cp s3://bucket/key - --quiet
      const uri = rest[0] as string;
      const val = store.get(uri);
      return {
        exited: Promise.resolve(val === undefined ? 1 : 0),
        stdout: new Response(val ?? "").body,
        stderr: new Response(val === undefined ? "NoSuchKey" : "").body,
      };
    }
    if (action === "rm") {
      const uri = rest[0] as string;
      store.delete(uri);
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
      };
    }
    throw new Error(`unstubbed aws invocation: ${JSON.stringify(args)}`);
  }) as unknown as typeof Bun.spawn);
}

describe("deploy-claim S3 acquire/release (stubbed S3)", () => {
  const bucket = "test-marker-bucket";
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  afterEach(() => {
    // restore Bun.spawn between tests
    (Bun.spawn as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  /**
   * Installs a hook that overwrites the stored claim with `rival` immediately after
   * each write whose 1-indexed sequence number is in `clobberWrites`, simulating a
   * concurrent writer racing in between our write and our read-back verification.
   */
  function injectRivalAfterWrites(
    store: Map<string, string>,
    rival: DeployClaim,
    clobberWrites: number[],
  ) {
    const trueSet = Map.prototype.set.bind(store);
    let writeCount = 0;
    store.set = (key, value) => {
      writeCount += 1;
      const out = trueSet(key, value);
      if (clobberWrites.includes(writeCount)) {
        trueSet(key, formatDeployClaim(rival));
      }
      return out;
    };
  }

  test("force succeeds when it genuinely wins", async () => {
    const store = new Map<string, string>();
    stubAwsS3(store);
    const pid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const rival = makeDeployClaim(sha, "88888888-8888-8888-8888-888888888888");

    // A rival clobbers our first (non-force) write, forcing us into the force branch —
    // but nobody clobbers the force branch's own write, so it genuinely wins.
    injectRivalAfterWrites(store, rival, [1]);

    const result = await acquireDeployClaim(bucket, sha, pid, { force: true, waitMs: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forced).toBe(true);
      expect(result.claim.id).toBe(pid);
    }
    const stored = await readDeployClaim(bucket);
    expect(stored?.id).toBe(pid);
  });

  test("force-path read-back mismatch is now detected and reported as failure", async () => {
    const store = new Map<string, string>();
    stubAwsS3(store);
    const pid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const rival = makeDeployClaim(sha, "99999999-9999-9999-9999-999999999999");

    // A rival clobbers BOTH our normal write and our forced write — the forcer must
    // detect it lost even its own force attempt, not just proceed optimistically.
    injectRivalAfterWrites(store, rival, [1, 2]);

    const result = await acquireDeployClaim(bucket, sha, pid, { force: true, waitMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("verify");
      if (result.reason === "verify") {
        expect(result.got?.id).toBe(rival.id);
      }
    }
  });

  test("release removes the key", async () => {
    const store = new Map<string, string>();
    stubAwsS3(store);
    const pid = "12121212-1212-1212-1212-121212121212";
    const claim = makeDeployClaim(sha, pid);
    const acquired = await acquireDeployClaim(bucket, sha, pid, { waitMs: 0 });
    expect(acquired.ok).toBe(true);
    expect(store.size).toBe(1);

    const err = await releaseDeployClaim(bucket, claim);
    expect(err).toBeNull();
    expect(store.size).toBe(0);
    expect(await readDeployClaim(bucket)).toBeNull();
  });

  test("missing key reads as no-claim", async () => {
    const store = new Map<string, string>();
    stubAwsS3(store);
    expect(await readDeployClaim(bucket)).toBeNull();
  });

  /**
   * Wraps the read path so the first `failCount` GETs against the marker key report a
   * transient failure (non-zero exit, no "NoSuchKey") instead of reflecting `store` —
   * simulating a network blip on the verifying read-back rather than "the key doesn't
   * exist" or "someone else's claim is there". Reads past `failCount` behave normally.
   */
  function stubAwsS3WithTransientReadFailures(store: Map<string, string>, failCount: number) {
    let readAttempts = 0;
    return spyOn(Bun, "spawn").mockImplementation(((
      args: string[],
      opts: Record<string, unknown>,
    ) => {
      const [, , action, ...rest] = args;
      if (action === "cp" && rest[0] === "-") {
        const uri = rest[1] as string;
        const exited = (async () => {
          const body = await new Response(opts.stdin as Blob).text();
          store.set(uri, body);
          return 0;
        })();
        return { exited, stdout: new Response("").body, stderr: new Response("").body };
      }
      if (action === "cp") {
        readAttempts += 1;
        if (readAttempts <= failCount) {
          return {
            exited: Promise.resolve(1),
            stdout: new Response("").body,
            stderr: new Response("simulated transient network error").body,
          };
        }
        const uri = rest[0] as string;
        const val = store.get(uri);
        return {
          exited: Promise.resolve(val === undefined ? 1 : 0),
          stdout: new Response(val ?? "").body,
          stderr: new Response(val === undefined ? "NoSuchKey" : "").body,
        };
      }
      if (action === "rm") {
        const uri = rest[0] as string;
        store.delete(uri);
        return {
          exited: Promise.resolve(0),
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      }
      throw new Error(`unstubbed aws invocation: ${JSON.stringify(args)}`);
    }) as unknown as typeof Bun.spawn);
  }

  test("a transient read-back blip that clears within the retry budget still succeeds", async () => {
    const store = new Map<string, string>();
    // acquireDeployClaim's own pre-write "is it already held" read is attempt #1 (fails
    // harmlessly — falls back to "no existing claim" and writes anyway); the verify
    // read-back is attempt #2 (fails); the first retry, attempt #3, sees our own
    // successful write and succeeds.
    stubAwsS3WithTransientReadFailures(store, 2);
    const pid = "13131313-1313-1313-1313-131313131313";

    const result = await acquireDeployClaim(bucket, sha, pid, {
      waitMs: 0,
      verifyRetryDelayMs: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claim.id).toBe(pid);
    // Our claim must still be the one sitting in the bucket — no orphan cleanup ran.
    expect((await readDeployClaim(bucket))?.id).toBe(pid);
  });

  test("a read-back that never recovers releases the claim we wrote instead of orphaning it", async () => {
    const store = new Map<string, string>();
    // Every read through the verify sequence fails transiently: the pre-write "is it
    // already held" read (#1), the initial verify read-back (#2), and both retries (#3,
    // #4). The 5th read (release's own lookup, after acquireDeployClaim gives up)
    // succeeds and sees our real write, so release can clean it up.
    stubAwsS3WithTransientReadFailures(store, 4);
    const pid = "14141414-1414-1414-1414-141414141414";

    const result = await acquireDeployClaim(bucket, sha, pid, {
      waitMs: 0,
      verifyRetryDelayMs: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("verify");
      if (result.reason === "verify") expect(result.got).toBeNull();
    }
    // The acquire must not leave its own successful write behind as an orphaned claim
    // that the next watch would report as "deploying by <user>" for the stale window.
    expect(store.size).toBe(0);
  });
});

describe("worktree-claim", () => {
  test("second process is held until force or stale", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-wt-"));
    const shadow = path.join(dir, "shadow");
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);
    const held = acquireWorktreeClaim(shadow, b);
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.claim.id).toBe(a);

    const forced = acquireWorktreeClaim(shadow, b, { force: true });
    expect(forced.ok).toBe(true);
    expect(readWorktreeClaim(shadow)?.id).toBe(b);

    expect(releaseWorktreeClaim(shadow, a)).toBe(false); // not owner
    expect(releaseWorktreeClaim(shadow, b)).toBe(true);
    expect(readWorktreeClaim(shadow)).toBeNull();
  });

  test("mtime older than stale window is inactive", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-wt-"));
    const shadow = path.join(dir, "shadow");
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    expect(acquireWorktreeClaim(shadow, id).ok).toBe(true);
    expect(isWorktreeClaimActive(shadow)).toBe(true);

    const old = new Date(Date.now() - WORKTREE_CLAIM_STALE_MS - 5_000);
    utimesSync(worktreeOwnerPath(shadow), old, old);
    expect(isWorktreeClaimActive(shadow)).toBe(false);

    // Stale claim can be taken without force.
    const other = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    expect(acquireWorktreeClaim(shadow, other).ok).toBe(true);
  });
});
