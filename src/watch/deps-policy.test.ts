import { describe, expect, test } from "bun:test";
import {
  decideAutoApplyUpdate,
  isRegistrySigned,
  isVettedForFreshRelease,
  parseTarget,
  trustMetaFromManifest,
} from "./deps-policy";

describe("parseTarget", () => {
  test("scoped package", () => {
    expect(parseTarget("@eslint/js@9.39.4")).toEqual({ name: "@eslint/js", version: "9.39.4" });
  });

  test("unscoped package", () => {
    expect(parseTarget("lodash@4.18.1")).toEqual({ name: "lodash", version: "4.18.1" });
  });

  test("invalid", () => {
    expect(parseTarget("nover")).toBeNull();
  });
});

describe("isVettedForFreshRelease", () => {
  test("provenance alone counts as vetted", () => {
    expect(
      isVettedForFreshRelease({
        hasProvenance: true,
        hasSignatures: true,
        hasStagedPublish: false,
        hasTrustedPublisher: false,
      }),
    ).toBe(true);
  });

  test("signatures alone are not vetted", () => {
    expect(
      isVettedForFreshRelease({
        hasProvenance: false,
        hasSignatures: true,
        hasStagedPublish: false,
        hasTrustedPublisher: false,
      }),
    ).toBe(false);
  });

  test("staged publish counts as vetted", () => {
    expect(
      isVettedForFreshRelease({
        hasProvenance: false,
        hasSignatures: true,
        hasStagedPublish: true,
        hasTrustedPublisher: false,
      }),
    ).toBe(true);
  });
});

describe("decideAutoApplyUpdate", () => {
  const policy = { minimumReleaseAge: 2880 };

  test("blocks fresh signed-only release", () => {
    const trust = trustMetaFromManifest({
      dist: { signatures: [{}] },
      publishedAt: new Date().toISOString(),
    });
    const decision = decideAutoApplyUpdate(trust, 30, policy);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("fresh release lacks SLSA provenance");
  });

  test("allows fresh provenanced release", () => {
    const trust = trustMetaFromManifest({
      dist: { attestations: { provenance: {} }, signatures: [{}] },
      _npmUser: { trustedPublisher: { id: "github" } },
      publishedAt: new Date().toISOString(),
    });
    const decision = decideAutoApplyUpdate(trust, 30, policy);
    expect(decision.allow).toBe(true);
  });

  test("allows aged signed-only release", () => {
    const trust = trustMetaFromManifest({
      dist: { signatures: [{}] },
    });
    const decision = decideAutoApplyUpdate(trust, 5000, policy);
    expect(decision.allow).toBe(true);
  });

  test("blocks release with no trust evidence", () => {
    const trust = trustMetaFromManifest({});
    expect(isRegistrySigned(trust!)).toBe(false);
    const decision = decideAutoApplyUpdate(trust, 5000, policy);
    expect(decision.allow).toBe(false);
  });
});
