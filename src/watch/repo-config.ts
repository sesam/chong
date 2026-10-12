/**
 * Shared shape of the per-repo "checks" declared in `<repo>/.chong/config.json` (or filled
 * in by {@link ./repo-profile.detectRepoProfile}). Kept in its own module so the commit gate,
 * `chong verify`, the watch loop and the deploy gate all agree on one definition.
 */
export type RepoCheckPhase = "commit" | "deploy";

export type RepoCheck = {
  name: string;
  /** Command, split on whitespace and run WITHOUT a shell. */
  cmd: string;
  /** Command that repairs what `cmd` reports (e.g. a formatter). Same argv rules as `cmd`. */
  fixCmd?: string;
  /**
   * `files`: the changed/given paths matching `match` are appended to `cmd`/`fixCmd`, and the
   * check is skipped when none match. `repo` (default): run as-is, but in the commit phase
   * still skipped when `match` is set and no changed path matches.
   */
  scope?: "files" | "repo";
  /** Simple globs (`**` / `*` / `?`); a pattern without `/` matches the basename anywhere. */
  match?: string[] | string;
  /** Working directory relative to the repo root. */
  cwd?: string;
  /** Phases this check runs in. Default: both. */
  phases?: RepoCheckPhase[];
};

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** True when `file` (repo-relative, `/`-separated) matches any glob. No globs = match all. */
export function matchesAnyGlob(file: string, globs: string[] | string | undefined): boolean {
  const list = typeof globs === "string" ? [globs] : globs; // tolerate `"match": "*.py"`
  if (!list || list.length === 0) return true;
  return list.some((g) => {
    const target = g.includes("/") ? file : (file.split("/").pop() ?? file);
    return globToRegExp(g).test(target);
  });
}

export function filterByGlobs(files: string[], globs: string[] | string | undefined): string[] {
  return files.filter((f) => matchesAnyGlob(f, globs));
}

/** Split a command line into argv, honouring simple "double" / 'single' quotes. No shell. */
export function splitArgv(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of cmd.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
