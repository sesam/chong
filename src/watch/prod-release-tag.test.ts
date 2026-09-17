import { describe, expect, it } from "bun:test";
import { prodReleaseTagName } from "./stage-deploy";

describe("prodReleaseTagName", () => {
  it("formats the deploy time as a sortable UTC tag", () => {
    expect(prodReleaseTagName(new Date("2026-09-17T08:32:06Z"))).toBe("prod-20260917-083206");
  });

  it("zero-pads every field so lexical order is chronological order", () => {
    expect(prodReleaseTagName(new Date("2026-01-02T03:04:05Z"))).toBe("prod-20260102-030405");
    const early = prodReleaseTagName(new Date("2026-01-02T03:04:05Z"));
    const later = prodReleaseTagName(new Date("2026-01-02T12:04:05Z"));
    expect([later, early].sort()).toEqual([early, later]);
  });

  it("uses UTC, not local time", () => {
    // 23:30 UTC is the next day in CEST; the tag must stay on the UTC date.
    expect(prodReleaseTagName(new Date("2026-06-30T23:30:00Z"))).toBe("prod-20260630-233000");
  });

  it("produces a name git accepts as a ref", () => {
    const tag = prodReleaseTagName(new Date("2026-12-31T23:59:59Z"));
    expect(tag).toMatch(/^prod-\d{8}-\d{6}$/);
    // No characters git refuses in a ref name (space, ~ ^ : ? * [ \ or ..).
    expect(tag).not.toMatch(/[\s~^:?*[\\]|\.\./);
  });
});
