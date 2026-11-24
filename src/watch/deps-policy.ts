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
    minimumReleaseAge: Number.isFinite(minimumReleaseAge)
      ? minimumReleaseAge
      : DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
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

export function trustMetaFromManifest(
  manifest: RegistryVersionMeta | null | undefined,
): TrustMeta | null {
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

const META_CACHE_TTL_MS = 15 * 60_000;
const META_CACHE_MAX = 256;
const META_FETCH_CONCURRENCY = 5;

const metaCache = new Map<string, { meta: RegistryVersionMeta | null; expiresAt: number }>();

/** Clear registry metadata cache (for tests). */
export function resetDepsMetaCache(): void {
  metaCache.clear();
}

function setMetaCache(key: string, meta: RegistryVersionMeta | null, now: number): void {
  if (metaCache.has(key)) metaCache.delete(key);
  metaCache.set(key, { meta, expiresAt: now + META_CACHE_TTL_MS });
  if (metaCache.size > META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
}

/** Minutes since `name@version` was published to the npm registry, or null on failure. */
export async function packagePublishAgeMinutes(
  name: string,
  version: string,
): Promise<number | null> {
  const meta = await fetchPackageRegistryMeta(name, version);
  const published = meta?.publishedAt;
  if (!published) return null;
  const ms = Date.parse(published);
  return Number.isFinite(ms) ? (Date.now() - ms) / 60_000 : null;
}

export async function packageTrustMeta(name: string, version: string): Promise<TrustMeta | null> {
  const meta = await fetchPackageRegistryMeta(name, version);
  return trustMetaFromManifest(meta);
}

/**
 * Fetch only the minimal fields needed for `name@version` once (cached 15m), rather than
 * downloading and retaining the full multi-MB packument twice per package.
 *
 * When `policy.minimumReleaseAge <= 0` we only need version trust metadata, which lives at
 * `/<pkg>/<version>` (a few KB). Otherwise we fetch the packument once, extract only
 * `dist.attestations.provenance`, `dist.signatures`, `_npmUser`, and `time[version]`, and
 * let the rest of the JSON be GC'd immediately.
 */
async function fetchPackageRegistryMeta(
  name: string,
  version: string,
  needPublishTime = true,
): Promise<RegistryVersionMeta | null> {
  const key = `${name}@${version}|${needPublishTime ? "full" : "ver"}`;
  const now = Date.now();
  const cached = metaCache.get(key);
  if (cached && now < cached.expiresAt) return cached.meta;

  try {
    if (!needPublishTime) {
      const verUrl = `${REGISTRY}/${encodePackage(name)}/${encodeURIComponent(version)}`;
      const res = await fetch(verUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        setMetaCache(key, null, now);
        return null;
      }
      const v = (await res.json()) as RegistryVersionMeta;
      const slim: RegistryVersionMeta = {
        _npmUser: v._npmUser,
        dist: v.dist
          ? {
              attestations: v.dist.attestations
                ? { provenance: v.dist.attestations.provenance }
                : undefined,
              signatures: v.dist.signatures,
            }
          : undefined,
        publishedAt: null,
      };
      setMetaCache(key, slim, now);
      return slim;
    }

    const packumentUrl = `${REGISTRY}/${encodePackage(name)}`;
    const res = await fetch(packumentUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      setMetaCache(key, null, now);
      return null;
    }
    const pack = (await res.json()) as {
      versions?: Record<string, RegistryVersionMeta>;
      time?: Record<string, string>;
    };
    const versionMeta = pack.versions?.[version];
    if (!versionMeta) {
      setMetaCache(key, null, now);
      return null;
    }
    // Extract only the tiny fields we care about so the multi-MB packument can be GC'd.
    const slim: RegistryVersionMeta = {
      _npmUser: versionMeta._npmUser,
      dist: versionMeta.dist
        ? {
            attestations: versionMeta.dist.attestations
              ? { provenance: versionMeta.dist.attestations.provenance }
              : undefined,
            signatures: versionMeta.dist.signatures,
          }
        : undefined,
      publishedAt: pack.time?.[version] ?? null,
    };
    setMetaCache(key, slim, now);
    return slim;
  } catch {
    return null;
  }
}

/**
 * Filter maintenance bump targets against release age + vetted-publish rules.
 * Fetches each package's registry metadata once with bounded concurrency.
 */
export async function filterDepsByReleasePolicy(
  targets: string[],
  policy: DepsPolicy,
  exceptionPackages: Set<string> = new Set(),
): Promise<{ allowed: string[]; blocked: FilteredTarget[] }> {
  const allowed: string[] = [];
  const blocked: FilteredTarget[] = [];
  const toCheck: Array<{ target: string; name: string; version: string }> = [];

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
    if (exceptionPackages.has(name)) {
      allowed.push(target);
      continue;
    }
    toCheck.push({ target, name, version });
  }

  const needPublishTime = policy.minimumReleaseAge > 0;
  for (let i = 0; i < toCheck.length; i += META_FETCH_CONCURRENCY) {
    const batch = toCheck.slice(i, i + META_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ target, name, version }) => {
        const meta = await fetchPackageRegistryMeta(name, version, needPublishTime);
        const trust = trustMetaFromManifest(meta);
        const pubMs = meta?.publishedAt ? Date.parse(meta.publishedAt) : Number.NaN;
        const ageMin = Number.isFinite(pubMs) ? (Date.now() - pubMs) / 60_000 : null;
        return { target, decision: decideAutoApplyUpdate(trust, ageMin, policy) };
      }),
    );
    for (const { target, decision } of results) {
      if (decision.allow) allowed.push(target);
      else blocked.push({ target, reason: decision.reason ?? "blocked by release policy" });
    }
  }

  return { allowed, blocked };
}
