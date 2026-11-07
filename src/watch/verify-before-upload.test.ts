import { describe, expect, test } from "bun:test";
import type { DeployClaim } from "./deploy-claim";
import { type PreUploadDeps, verifyBeforeUpload } from "./stage-deploy";

const SHA = "a".repeat(40);
const NEWER = "b".repeat(40);
const LIVE = "c".repeat(40);
const T0 = Date.parse("2026-11-07T10:00:00Z");
const claim = (over: Partial<DeployClaim> = {}): DeployClaim => ({
  v: 1,
  id: "proc-1",
  user: "si",
  sha: SHA,
  at: new Date(T0).toISOString(),
  ...over,
});
const deps = (over: Partial<PreUploadDeps> = {}): PreUploadDeps => ({
  readClaim: async () => claim(),
  fetchRemoteTip: async () => ({ sha: SHA }),
  readLiveCommit: async () => LIVE,
  now: () => T0 + 60_000,
  ...over,
});
const stage = (over: Record<string, unknown> = {}) => ({
  target: "stage" as const,
  sha: SHA,
  claim: claim(),
  liveAtStart: LIVE,
  ...over,
});

describe("verifyBeforeUpload", () => {
  test("proceeds when claim, origin and live are all unchanged", async () => {
    expect(await verifyBeforeUpload(stage(), deps())).toBeNull();
  });

  test("defers when origin/main moved ahead (sleeping-machine case)", async () => {
    const r = await verifyBeforeUpload(
      stage(),
      deps({ fetchRemoteTip: async () => ({ sha: NEWER }) }),
    );
    expect(r?.action).toBe("deferred");
    expect(r?.message).toMatch(/origin\/main moved to bbbbbbb/);
  });

  test("defers when the fetch fails: never ship without knowing origin", async () => {
    const r = await verifyBeforeUpload(
      stage(),
      deps({ fetchRemoteTip: async () => ({ error: "network down" }) }),
    );
    expect(r?.action).toBe("deferred");
    expect(r?.message).toMatch(/could not fetch/);
  });

  test("defers when another watch took the claim", async () => {
    const r = await verifyBeforeUpload(
      stage(),
      deps({ readClaim: async () => claim({ id: "proc-2", user: "other" }) }),
    );
    expect(r?.message).toMatch(/claim now held by other/);
    expect(r?.claim?.id).toBe("proc-2");
  });

  test("defers when the claim was cleared", async () => {
    const r = await verifyBeforeUpload(stage(), deps({ readClaim: async () => null }));
    expect(r?.message).toMatch(/claim cleared/);
  });

  test("defers when our own claim is for another sha", async () => {
    const r = await verifyBeforeUpload(
      stage(),
      deps({ readClaim: async () => claim({ sha: NEWER }) }),
    );
    expect(r?.message).toMatch(/claim is for bbbbbbb/);
  });

  test("defers when our claim went stale (asleep past the stale window)", async () => {
    const r = await verifyBeforeUpload(stage(), deps({ now: () => T0 + 21 * 60_000 }));
    expect(r?.message).toMatch(/went stale/);
  });

  test("defers when someone else deployed meanwhile", async () => {
    const r = await verifyBeforeUpload(stage(), deps({ readLiveCommit: async () => NEWER }));
    expect(r?.message).toMatch(/stage changed to bbbbbbb/);
  });

  test("live already equal to our sha is fine (idempotent)", async () => {
    expect(await verifyBeforeUpload(stage(), deps({ readLiveCommit: async () => SHA }))).toBeNull();
  });

  test("prod skips the origin check and still checks live", async () => {
    const prod = { ...stage(), target: "prod" as const };
    expect(await verifyBeforeUpload(prod, deps({ fetchRemoteTip: null }))).toBeNull();
    const r = await verifyBeforeUpload(
      prod,
      deps({ fetchRemoteTip: null, readLiveCommit: async () => NEWER }),
    );
    expect(r?.message).toMatch(/^prod deploy deferred/);
  });

  test("no bucket (no claim) still checks origin", async () => {
    const r = await verifyBeforeUpload(
      stage({ claim: null }),
      deps({ fetchRemoteTip: async () => ({ sha: NEWER }) }),
    );
    expect(r?.action).toBe("deferred");
  });
});
