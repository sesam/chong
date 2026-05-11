import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git";

export async function defaultRepo(): Promise<string> {
  try {
    const main = await git.mainWorktree();
    const cfgPath = join(main, ".chong", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(await Bun.file(cfgPath).text()) as { repo?: string };
      if (cfg.repo) return cfg.repo;
    }
  } catch {
    // not in a git repo / no config
  }

  try {
    const url = await git.remoteUrl();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
    }
    if (url.startsWith("git@")) {
      return url.replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
    }
  } catch {
    // no remote
  }
  return "";
}
