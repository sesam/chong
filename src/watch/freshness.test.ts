import { describe, expect, test } from "bun:test";
import { staleChongMessage } from "./freshness";

describe("staleChongMessage", () => {
  const cfg = { minChongBuild: "2026-10-19T00:00:00Z", minChongReason: "oxlint gate" };

  test("older build is rejected with reason and upgrade hint", () => {
    const msg = staleChongMessage(cfg, "2026-10-16T14:51:00Z");
    expect(msg).toContain("2026-10-19T00:00:00Z");
    expect(msg).toContain("oxlint gate");
    expect(msg).toContain("upgrade");
  });
  test("same or newer build passes", () => {
    expect(staleChongMessage(cfg, "2026-10-19T00:00:00Z")).toBeNull();
    expect(staleChongMessage(cfg, "2026-11-01T00:00:00Z")).toBeNull();
  });
  test("dev builds, missing or malformed minimums pass", () => {
    expect(staleChongMessage(cfg, "dev")).toBeNull();
    expect(staleChongMessage({}, "2020-01-01T00:00:00Z")).toBeNull();
    expect(staleChongMessage({ minChongBuild: "soon" }, "2020-01-01T00:00:00Z")).toBeNull();
  });
  test("unparseable own build counts as stale", () => {
    expect(staleChongMessage(cfg, "garbage")).not.toBeNull();
  });
});
