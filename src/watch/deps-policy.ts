import { readFile } from "node:fs/promises";
import path from "node:path";

/** Defaults when pnpm-workspace.yaml has no supply-chain block (48h cooldown). */
export const DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 2880;

export type DepsPolicy = {
  /** Minutes after publish before a version may be installed/updated. 0 = off. */
  minimumReleaseAge: number;
};

/** Registry trust signals for a single package version. */
export type TrustMeta = {
  hasProvenance: boolean;
  hasSignatures: boolean;
  hasStagedPublish: boolean;
  hasTrustedPublisher: boolean;
};

export type FilteredTarget = {
  target: string;
  reason: string;
};

export type AutoApplyDecision = {
  allow: boolean;
  reason?: string;
};

/** Read `minimumReleaseAge` from the repo's pnpm-workspace.yaml (if present). */
export async function readDepsPolicy(repoPath: string): Promise<DepsPolicy> {
  const file = path.join(repoPath, "pnpm-workspace.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { minimumReleaseAge: DEFAULT_MINIMUM_RELEASE_AGE_MINUTES };
  }

  const match = text.match(/^minimumReleaseAge:\s*(\d+)\s*$/m);
  const minimumReleaseAge = match
    ? Number.parseInt(match[1], 10)
    : DEFAULT_MINIMUM_RELEASE_AGE_MINUTES;

  return {
    minimumReleaseAge: Number.isFinite(minimumReleaseAge) ? minimumReleaseAge : DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
  };
}

export function parseTarget(target: string): { name: string; version: string } | null {
  if (target.startsWith("@")) {
    const slash = target.indexOf("/");
    const at = target.indexOf("@", slash + 1);
    if (slash === -1 || at === -1) return null;
    return { name: target.slice(0, at), version: target.slice(at + 1) };
  }
  const at = target.indexOf("@");
  if (at <= 0) return null;
  return { name: target.slice(0, at), version: target.slice(at + 1) };
}

function encodePackage(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

const REGISTRY = "https://registry.npmjs.org";

/** True when the release was vetted by a trustable publisher (not just npm-signed). */
export function isVettedForFreshRelease(trust: TrustMeta): boolean {
  if (trust.hasStagedPublish) return true;
  if (trust.hasProvenance && trust.hasTrustedPublisher) return true;
  return trust.hasProvenance;
}

/** Minimum bar: npm registry signature and/or SLSA provenance attestation. */
export function isRegistrySigned(trust: TrustMeta): boolean {
  return trust.hasProvenance || trust.hasSignatures;
}

/**
 * Maintenance may auto-apply a bump when the target is aged out OR freshly published
 * but vetted (SLSA provenance, staged publish, or trusted publisher + provenance).
 * Signatures alone are not enough for fresh releases (axios@1.14.1 had neither).
 */
export function decideAutoApplyUpdate(
  trust: TrustMeta | null,
  ageMin: number | null,
  policy: DepsPolicy,
): AutoApplyDecision {
  if (!trust) {
    return { allow: false, reason: "could not verify registry metadata" };
  }

  if (!isRegistrySigned(trust)) {
    return { allow: false, reason: "no registry provenance or signatures" };
  }

  if (policy.minimumReleaseAge <= 0) {
    return { allow: true };
  }

  if (ageMin === null) {
    return { allow: false, reason: "could not verify publish time" };
  }

  if (ageMin >= policy.minimumReleaseAge) {
    return { allow: true };
  }

  if (isVettedForFreshRelease(trust)) {
    return { allow: true };
  }

  const hoursLeft = Math.ceil((policy.minimumReleaseAge - ageMin) / 60);
  return {
    allow: false,
    reason: `published ${Math.floor(ageMin / 60)}h ago — fresh release lacks SLSA provenance/staged publish (wait ~${hoursLeft}h)`,
  };
}

export function trustMetaFromManifest(manifest: RegistryVersionMeta | null | undefined): TrustMeta | null {
  if (!manifest) return null;
  const npmUser = parseNpmUser(manifest._npmUser);
  return {
    hasProvenance: Boolean(manifest.dist?.attestations?.provenance),
    hasSignatures: Array.isArray(manifest.dist?.signatures) && manifest.dist.signatures.length > 0,
    hasStagedPublish: npmUser.hasStagedPublish,
    hasTrustedPublisher: npmUser.hasTrustedPublisher,
  };
}

type RegistryVersionMeta = {
  _npmUser?: unknown;
  dist?: { attestations?: { provenance?: unknown }; signatures?: unknown[] };
  publishedAt?: string | null;
};

function parseNpmUser(raw: unknown): { hasStagedPublish: boolean; hasTrustedPublisher: boolean } {
  if (!raw || typeof raw !== "object") {
    return { hasStagedPublish: false, hasTrustedPublisher: false };
  }
  const user = raw as { approver?: unknown; trustedPublisher?: unknown };
  return {
    hasStagedPublish: Boolean(user.approver),
    hasTrustedPublisher: Boolean(user.trustedPublisher),
  };
}

/** Minutes since `name@version` was published to the npm registry, or null on failure. */
export async function packagePublishAgeMinutes(
  name: string,
  version: string,
): Promise<number | null> {
  const meta = await fetchPackageRegistryMeta(name, version);
  const published = meta?.publishedAt;
  if (!published) return null;
  return (Date.now() - new Date(published).getTime()) / 60_000;
}

export async function packageTrustMeta(name: string, version: string): Promise<TrustMeta | null> {
  const meta = await fetchPackageRegistryMeta(name, version);
  return trustMetaFromManifest(meta);
}

async function fetchPackageRegistryMeta(
  name: string,
  version: string,
): Promise<RegistryVersionMeta | null> {
  const packumentUrl = `${REGISTRY}/${encodePackage(name)}`;
  try {
    const res = await fetch(packumentUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const pack = (await res.json()) as {
      versions?: Record<string, RegistryVersionMeta>;
      time?: Record<string, string>;
    };
    const versionMeta = pack.versions?.[version];
    if (!versionMeta) return null;
    return { ...versionMeta, publishedAt: pack.time?.[version] ?? null };
  } catch {
    return null;
  }
}

/** Filter maintenance bump targets against release age + vetted-publish rules. */
export async function filterDepsByReleasePolicy(
  targets: string[],
  policy: DepsPolicy,
): Promise<{ allowed: string[]; blocked: FilteredTarget[] }> {
  const allowed: string[] = [];
  const blocked: FilteredTarget[] = [];

  for (const target of targets) {
    const parsed = parseTarget(target);
    if (!parsed) {
      blocked.push({ target, reason: "unparseable target" });
      continue;
    }

    const { name, version } = parsed;
    if (name.startsWith("@fortawesome/") || name.startsWith("@awesome.me/")) {
      allowed.push(target);
      continue;
    }

    const trust = await packageTrustMeta(name, version);
    const ageMin = await packagePublishAgeMinutes(name, version);
    const decision = decideAutoApplyUpdate(trust, ageMin, policy);

    if (decision.allow) {
      allowed.push(target);
    } else {
      blocked.push({ target, reason: decision.reason ?? "blocked by release policy" });
    }
  }

  return { allowed, blocked };
}
