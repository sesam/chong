import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAIM_STALE_MS,
  formatClaimHolder,
  formatDeployClaim,
  isClaimStale,
  makeDeployClaim,
  parseDeployClaim,
} from "./deploy-claim";
import {
  acquireWorktreeClaim,
  isWorktreeClaimActive,
  readWorktreeClaim,
  releaseWorktreeClaim,
  WORKTREE_CLAIM_STALE_MS,
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
