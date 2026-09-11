import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WORKTREE_CLAIM_STALE_MS,
  WORKTREE_CLAIM_TOUCH_MS,
  acquireWorktreeClaim,
  formatWorktreeHolder,
  isWorktreeClaimActive,
  parseWorktreeClaim,
  readWorktreeClaim,
  touchWorktreeClaim,
  worktreeOwnerPath,
} from "./worktree-claim";

function freshShadow(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chong-wt-claim-"));
  return path.join(dir, "shadow");
}

describe("worktree-claim constants", () => {
  test("touch interval is a fraction of the stale window, not equal to it", () => {
    expect(WORKTREE_CLAIM_STALE_MS).toBe(20 * 60 * 1_000);
    expect(WORKTREE_CLAIM_TOUCH_MS).toBeLessThan(WORKTREE_CLAIM_STALE_MS);
    // Several touches must land per stale window so jitter/a slow tick can't starve one.
    expect(WORKTREE_CLAIM_STALE_MS / WORKTREE_CLAIM_TOUCH_MS).toBeGreaterThanOrEqual(3);
  });
});

describe("acquireWorktreeClaim: exclusive create", () => {
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  test("two acquires on an unclaimed worktree: exactly one wins", () => {
    const shadow = freshShadow();
    const first = acquireWorktreeClaim(shadow, a);
    const second = acquireWorktreeClaim(shadow, b);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.claim.id).toBe(a);
    expect(readWorktreeClaim(shadow)?.id).toBe(a);
  });

  test("EEXIST race: a claim written between B's read and B's write is not clobbered", () => {
    const shadow = freshShadow();

    // A really claims the worktree first.
    const first = acquireWorktreeClaim(shadow, a);
    expect(first.ok).toBe(true);

    // Simulate B's read racing ahead of A's already-committed write: force B's very next
    // readFileSync (inside readWorktreeClaim) to fail, so B believes there is no existing
    // claim. B then falls into the exclusive-create path, where the real O_EXCL write hits
    // a genuine EEXIST (A's file is actually on disk) and must retry rather than overwrite.
    const readSpy = spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("simulated race: read lost to a concurrent writer");
    });
    try {
      const second = acquireWorktreeClaim(shadow, b);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.claim.id).toBe(a);
    } finally {
      readSpy.mockRestore();
    }

    // A's claim must survive untouched — B never got to overwrite it.
    expect(readWorktreeClaim(shadow)?.id).toBe(a);
  });
});

describe("acquireWorktreeClaim: stale takeover", () => {
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  test("a live claim blocks a non-force acquire", () => {
    const shadow = freshShadow();
    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);
    const res = acquireWorktreeClaim(shadow, b);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.claim.id).toBe(a);
  });

  test("a claim past the stale window is taken over without force", () => {
    const shadow = freshShadow();
    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);
    const p = worktreeOwnerPath(shadow);
    const old = new Date(Date.now() - WORKTREE_CLAIM_STALE_MS - 1_000);
    utimesSync(p, old, old);
    expect(isWorktreeClaimActive(shadow)).toBe(false);

    const res = acquireWorktreeClaim(shadow, b);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claim.id).toBe(b);
    expect(readWorktreeClaim(shadow)?.id).toBe(b);
  });
});

describe("acquireWorktreeClaim: force override", () => {
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  test("force replaces a live foreign claim and reports forced:true", () => {
    const shadow = freshShadow();
    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);
    expect(isWorktreeClaimActive(shadow)).toBe(true);

    const res = acquireWorktreeClaim(shadow, b, { force: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.forced).toBe(true);
      expect(res.claim.id).toBe(b);
    }
    expect(readWorktreeClaim(shadow)?.id).toBe(b);
  });

  test("force is a no-op flag (not `forced`) when there was nothing foreign to replace", () => {
    const shadow = freshShadow();
    const res = acquireWorktreeClaim(shadow, a, { force: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.forced).toBeFalsy();
  });
});

describe("touchWorktreeClaim keeps a claim alive past the old 20-minute mark", () => {
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  test("periodic touches at the new interval never let the claim go stale", () => {
    const shadow = freshShadow();
    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);
    const p = worktreeOwnerPath(shadow);

    const OLD_SINGLE_WINDOW_MS = 20 * 60 * 1_000;
    let simulatedElapsed = 0;
    // Advance simulated time well past the old (touch === stale) 20-minute mark, touching
    // on the new, shorter interval each tick — mimicking the 1s clock in app.ts calling
    // maybeTouchWorktreeClaim while ownership continues (no commit activity required).
    while (simulatedElapsed < OLD_SINGLE_WINDOW_MS + 5 * 60 * 1_000) {
      simulatedElapsed += WORKTREE_CLAIM_TOUCH_MS;
      const backdated = new Date(Date.now() - (WORKTREE_CLAIM_TOUCH_MS - 1_000));
      utimesSync(p, backdated, backdated);
      expect(touchWorktreeClaim(shadow, a)).toBe(true);
      expect(isWorktreeClaimActive(shadow)).toBe(true);
    }
  });

  test("touch fails and reports loss once another process legitimately owns the file", () => {
    const shadow = freshShadow();
    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);
    const p = worktreeOwnerPath(shadow);
    const old = new Date(Date.now() - WORKTREE_CLAIM_STALE_MS - 1_000);
    utimesSync(p, old, old);

    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(acquireWorktreeClaim(shadow, b).ok).toBe(true);

    // A's own touch must now fail — it no longer owns the file.
    expect(touchWorktreeClaim(shadow, a)).toBe(false);
  });
});

describe("claim field sanitization", () => {
  test("parseWorktreeClaim strips ANSI escapes and control characters", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      user: "simon\x1b[31m\x07pwned",
      at: "2026-09-10T12:00:00.000Z",
      host: "mbp\x1b]0;evil\x07",
    });
    const claim = parseWorktreeClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;

    // biome-ignore lint/suspicious/noControlCharactersInRegex: assertion needs to detect what we stripped
    const controlOrEscape = /[\x00-\x1f\x7f]/;
    expect(controlOrEscape.test(claim.user)).toBe(false);
    expect(controlOrEscape.test(claim.host ?? "")).toBe(false);
    expect(claim.user).toContain("simon");
    expect(claim.user).toContain("pwned");
    expect(claim.host).toContain("mbp");

    const formatted = formatWorktreeHolder(claim);
    expect(controlOrEscape.test(formatted)).toBe(false);
  });

  test("parseWorktreeClaim caps absurdly long user/host fields", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      user: "x".repeat(500),
      at: "2026-09-10T12:00:00.000Z",
      host: "y".repeat(500),
    });
    const claim = parseWorktreeClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;
    expect(claim.user.length).toBeLessThanOrEqual(80);
    expect((claim.host ?? "").length).toBeLessThanOrEqual(80);
  });

  test("a user field that is only control characters is rejected", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      user: "\x1b[31m\x07",
      at: "2026-09-10T12:00:00.000Z",
    });
    expect(parseWorktreeClaim(raw)).toBeNull();
  });
});
