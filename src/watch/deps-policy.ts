import { readFile } from "node:fs/promises";
import path from "node:path";

/** Defaults when pnpm-workspace.yaml has no supply-chain block (48h cooldown). */
export const DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 2880;

export type DepsPolicy = {
  /** Minutes after publish before a version may be installed/updated. 0 = off. */
  minimumReleaseAge: number;
};

export type TrustMeta = {
  hasProvenance: boolean;
  hasSignatures: boolean;
};

export type FilteredTarget = {
  target: string;
  reason: string;
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
  if (!meta) return null;
  return {
    hasProvenance: Boolean(meta.dist?.attestations?.provenance),
    hasSignatures: Array.isArray(meta.dist?.signatures) && meta.dist.signatures.length > 0,
  };
}

async function fetchPackageRegistryMeta(
  name: string,
  version: string,
): Promise<{
  dist?: { attestations?: { provenance?: unknown }; signatures?: unknown[] };
  publishedAt?: string | null;
} | null> {
  const packumentUrl = `${REGISTRY}/${encodePackage(name)}`;
  try {
    const res = await fetch(packumentUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const pack = (await res.json()) as {
      versions?: Record<
        string,
        { dist?: { attestations?: { provenance?: unknown }; signatures?: unknown[] } }
      >;
      time?: Record<string, string>;
    };
    const versionMeta = pack.versions?.[version];
    if (!versionMeta) return null;
    return { ...versionMeta, publishedAt: pack.time?.[version] ?? null };
  } catch {
    return null;
  }
}

/**
 * Drop update targets that are too fresh or lack registry trust evidence
 * (neither SLSA provenance nor npm signatures — the axios@1.14.1 pattern).
 */
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
    const verified = Boolean(trust?.hasProvenance || trust?.hasSignatures);
    if (trust && !verified) {
      blocked.push({
        target,
        reason: "no registry provenance or signatures",
      });
      continue;
    }

    if (policy.minimumReleaseAge <= 0) {
      allowed.push(target);
      continue;
    }

    const ageMin = await packagePublishAgeMinutes(name, version);
    if (ageMin === null) {
      blocked.push({ target, reason: "could not verify publish time" });
      continue;
    }

    if (ageMin < policy.minimumReleaseAge && !verified) {
      const hours = Math.ceil((policy.minimumReleaseAge - ageMin) / 60);
      blocked.push({
        target,
        reason: `published ${Math.floor(ageMin / 60)}h ago, unverified — wait ~${hours}h more (minimumReleaseAge ${policy.minimumReleaseAge}m)`,
      });
      continue;
    }

    allowed.push(target);
  }

  return { allowed, blocked };
}
