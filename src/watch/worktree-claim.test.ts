import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  writeWorktreeClaim,
  type WorktreeClaim,
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

  test("a delayed touch does not revert a legitimate force override (CAS race)", () => {
    const shadow = freshShadow();
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(acquireWorktreeClaim(shadow, a).ok).toBe(true);

    const realReadFileSync = fs.readFileSync.bind(fs);
    let calls = 0;
    // Simulates: touch's *first* read (its `readWorktreeClaim(shadowPath)` at the top of
    // touchWorktreeClaim) captures A's still-live claim, then — before touch does its
    // pre-write recheck — B legitimately force-overrides on disk. Without the fix, touch
    // would go on to unconditionally rewrite A's claim back over B's, reviving a claim
    // both processes think they own even though B (possibly already resetting the
    // worktree) genuinely won. With the fix, touch's recheck must see B's claim and
    // report loss instead.
    const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      calls += 1;
      // @ts-expect-error -- passthrough to the real implementation with original args
      const result = realReadFileSync(...args);
      if (calls === 1) {
        spy.mockRestore();
        const forced = acquireWorktreeClaim(shadow, b, { force: true });
        expect(forced.ok).toBe(true);
      }
      return result;
    }) as typeof fs.readFileSync);

    let touched: boolean;
    try {
      touched = touchWorktreeClaim(shadow, a);
    } finally {
      spy.mockRestore();
    }

    expect(touched).toBe(false);
    expect(readWorktreeClaim(shadow)?.id).toBe(b);
  });
});

describe("writeWorktreeClaim: symlink safety", () => {
  test("replaces a symlink planted at the owner path instead of following it", () => {
    const shadow = freshShadow();
    const dir = path.dirname(worktreeOwnerPath(shadow));
    const victimPath = path.join(dir, "victim.json");
    writeFileSync(victimPath, "precious operator data\n", "utf8");

    const ownerPath = worktreeOwnerPath(shadow);
    symlinkSync(victimPath, ownerPath);
    expect(lstatSync(ownerPath).isSymbolicLink()).toBe(true);

    const claim: WorktreeClaim = {
      v: 1,
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      user: "attacker",
      at: new Date().toISOString(),
    };
    writeWorktreeClaim(shadow, claim);

    // The file the symlink pointed at must be untouched — a naive writeFileSync(ownerPath)
    // would have followed the link and clobbered it with claim JSON.
    expect(readFileSync(victimPath, "utf8")).toBe("precious operator data\n");
    // The owner path itself is now a plain file holding our claim, not a symlink anymore.
    expect(lstatSync(ownerPath).isSymbolicLink()).toBe(false);
    expect(readWorktreeClaim(shadow)?.id).toBe(claim.id);
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
      // Only C0/DEL control bytes, no printable punctuation/digits/letters left behind —
      // the whole field must sanitize down to empty and reject the claim.
      user: "\x01\x02\x1b\x07\x7f",
      at: "2026-09-10T12:00:00.000Z",
    });
    expect(parseWorktreeClaim(raw)).toBeNull();
  });

  test("parseWorktreeClaim strips 8-bit C1 CSI/OSC bytes a 7-bit-only denylist would miss", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "11111111-1111-1111-1111-111111111111",
      // U+009B (CSI) / U+009D (OSC) — real C1-aware terminals (xterm, iTerm2) act on
      // these even though there is no ESC (\x1b) byte anywhere in the string.
      user: "simon31mpwned",
      at: "2026-09-10T12:00:00.000Z",
      host: "mbp0;evilhost",
    });
    const claim = parseWorktreeClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;
    const c1OrControl = /[\x00-\x1f\x7f-\x9f]/;
    expect(c1OrControl.test(claim.user)).toBe(false);
    expect(c1OrControl.test(claim.host ?? "")).toBe(false);
    expect(claim.user).toContain("simon");
    expect(claim.user).toContain("pwned");
    expect(claim.host).toContain("mbp");
    expect(claim.host).toContain("evilhost");
  });

  test("parseWorktreeClaim strips RTL override and zero-width format characters", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "22222222-2222-2222-2222-222222222222",
      // U+202E (RTL override) + U+200B (zero-width space): both are Unicode format
      // characters (\p{Cf}), not control bytes, so a control-char-only denylist misses
      // them; both are usable to visually spoof another operator's rendered name.
      user: "simon‮evil​user",
      at: "2026-09-10T12:00:00.000Z",
    });
    const claim = parseWorktreeClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;
    expect(claim.user).not.toContain("‮");
    expect(claim.user).not.toContain("​");
    expect(claim.user).toBe("simoneviluser");
  });

  test("parseWorktreeClaim drops stray combining marks (Zalgo-style stacking)", () => {
    const zalgo = `e${"́".repeat(40)}`; // one base letter + 40 combining acute accents
    const raw = JSON.stringify({
      v: 1,
      id: "33333333-3333-3333-3333-333333333333",
      user: zalgo,
      at: "2026-09-10T12:00:00.000Z",
    });
    const claim = parseWorktreeClaim(raw);
    expect(claim).not.toBeNull();
    if (!claim) return;
    // NFC composes the base letter with the first combining mark into a single
    // precomposed "é" (category Ll, allowed); the other 39 stray combining marks are
    // category M, outside the L/N/P/Zs allowlist, so the whole rest of the run is
    // dropped rather than merely capped.
    expect(claim.user).toBe("é");
    expect(claim.user.length).toBe(1);
  });

  test("a user field of only whitespace trims to empty and rejects the claim (matches deploy-claim's .trim())", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "44444444-4444-4444-4444-444444444444",
      user: " ".repeat(70),
      at: "2026-09-10T12:00:00.000Z",
    });
    expect(parseWorktreeClaim(raw)).toBeNull();
  });
});
