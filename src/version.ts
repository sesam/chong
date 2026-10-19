/**
 * Build stamp, injected by `scripts/build.ts` (`--define`). A plain `bun src/index.ts` run has
 * neither, so it reports "dev" and is never rejected by a repo's `minChongBuild`.
 */
declare const CHONG_BUILD_TIME: string | undefined;
declare const CHONG_BUILD_COMMIT: string | undefined;

export const buildTime: string = typeof CHONG_BUILD_TIME === "string" ? CHONG_BUILD_TIME : "dev";
export const buildCommit: string =
  typeof CHONG_BUILD_COMMIT === "string" ? CHONG_BUILD_COMMIT : "dev";

export function versionLine(): string {
  return `chong ${buildCommit} built ${buildTime}`;
}
