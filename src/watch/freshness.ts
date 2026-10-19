import { buildTime } from "../version";
import { loadRepoDeployConfig } from "./stage-deploy";

/**
 * Message when this chong build is older than the repo's `minChongBuild` (an ISO timestamp in
 * `<repo>/.chong/config.json`), else null. Unstamped ("dev") builds and unparseable values pass:
 * a typo in a committed config must not lock everyone out.
 */
export function staleChongMessage(
  cfg: { minChongBuild?: unknown; minChongReason?: unknown },
  build: string = buildTime,
): string | null {
  if (typeof cfg.minChongBuild !== "string") return null;
  const need = Date.parse(cfg.minChongBuild);
  if (Number.isNaN(need)) return null;
  if (build === "dev") return null;
  const have = Date.parse(build);
  if (!Number.isNaN(have) && have >= need) return null;
  const reason = typeof cfg.minChongReason === "string" ? `\n  why: ${cfg.minChongReason}` : "";
  const upgrade =
    "  upgrade: update the chong checkout, rebuild, reinstall (FRONTEND: `pnpm install:chong`), then restart.";
  return `this repo needs a chong built at or after ${cfg.minChongBuild}; yours is ${build}.${reason}\n${upgrade}`;
}

/** Throws the upgrade message when the running chong is too old for `repoPath`. */
export function assertChongFresh(repoPath: string): void {
  const msg = staleChongMessage(loadRepoDeployConfig(repoPath));
  if (msg) throw new Error(msg);
}
