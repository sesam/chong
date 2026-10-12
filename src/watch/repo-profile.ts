import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RepoCheck } from "./repo-config";
import { FORBIDDEN_CMD_CHARS, loadRepoDeployConfig } from "./stage-deploy";

export type RepoKind = "node" | "python" | "generic";

export type RepoSupports = {
  i18n: boolean;
  lockfile: boolean;
  depsBump: boolean;
  eslint: boolean;
  importScan: boolean;
};

export type RepoProfile = {
  kind: RepoKind;
  /** Whole-tree formatter used by the post-commit FIX step. Empty = nothing to run. */
  formatCmd: string;
  /** Unit-test command for maintenance. Empty = nothing to run. */
  testCmd: string;
  checks: RepoCheck[];
  supports: RepoSupports;
  /** Paths (repo-relative) symlinked into shadow worktrees, besides node_modules. */
  shadowLinks: string[];
};

const ALL: RepoSupports = {
  i18n: true,
  lockfile: true,
  depsBump: true,
  eslint: true,
  importScan: true,
};
const NONE: RepoSupports = {
  i18n: false,
  lockfile: false,
  depsBump: false,
  eslint: false,
  importScan: false,
};

/** `uv run --no-sync` keeps a shadow's symlinked .venv from being re-synced by a check. */
function ruffPrefix(repoPath: string): string {
  if (Bun.which("uv")) return "uv run --no-sync ruff";
  const venv = path.join(repoPath, ".venv", "bin", "ruff");
  return existsSync(venv) ? venv : "ruff";
}

function pythonChecks(repoPath: string): RepoCheck[] {
  const pyproject = path.join(repoPath, "pyproject.toml");
  const text = existsSync(pyproject) ? readFileSync(pyproject, "utf8") : "";
  const usesRuff = /\bruff\b/.test(text) || existsSync(path.join(repoPath, "ruff.toml"));
  if (!usesRuff) return [];
  const r = ruffPrefix(repoPath);
  const match = ["**/*.py", "**/*.pyi"];
  // --force-exclude: honour pyproject `extend-exclude` even for explicitly named files.
  return [
    {
      name: "ruff lint",
      cmd: `${r} check --force-exclude`,
      fixCmd: `${r} check --fix --force-exclude`,
      scope: "files",
      match,
    },
    {
      name: "ruff format",
      cmd: `${r} format --check --force-exclude`,
      fixCmd: `${r} format --force-exclude`,
      scope: "files",
      match,
    },
  ];
}

/** Keep configured checks whose commands pass the same metacharacter screen as deploy cmds. */
function sanitizeConfigured(checks: unknown, repoPath: string): RepoCheck[] {
  if (!Array.isArray(checks)) return [];
  const ok: RepoCheck[] = [];
  for (const raw of checks) {
    const ck = raw as Partial<RepoCheck> | null;
    if (!ck || typeof ck.name !== "string" || typeof ck.cmd !== "string" || !ck.cmd.trim())
      continue;
    const bad = [ck.cmd, ck.fixCmd ?? ""].some((s) => FORBIDDEN_CMD_CHARS.test(s));
    if (bad) {
      console.error(
        `chong: refusing .chong/config.json check "${ck.name}" (${repoPath}) — command contains a shell metacharacter.`,
      );
      continue;
    }
    ok.push(ck as RepoCheck);
  }
  return ok;
}

export function detectRepoProfile(repoPath: string): RepoProfile {
  const configured = loadRepoDeployConfig(repoPath).checks;
  const hasPkg = existsSync(path.join(repoPath, "package.json"));
  const isPython =
    !hasPkg &&
    (existsSync(path.join(repoPath, "pyproject.toml")) ||
      existsSync(path.join(repoPath, "uv.lock")));

  let base: RepoProfile;
  if (hasPkg) {
    // Today's behaviour, unchanged.
    base = {
      kind: "node",
      formatCmd: "pnpm format",
      testCmd: "pnpm test",
      checks: [],
      supports: { ...ALL },
      shadowLinks: [],
    };
  } else if (isPython) {
    const r = ruffPrefix(repoPath);
    const checks = pythonChecks(repoPath);
    const usesRuff = checks.length > 0;
    base = {
      kind: "python",
      formatCmd: usesRuff ? `${r} format --force-exclude` : "",
      testCmd: 'uv run --no-sync pytest -q -m "not integration"',
      checks,
      supports: { ...NONE },
      shadowLinks: [".venv"],
    };
  } else {
    base = {
      kind: "generic",
      formatCmd: "",
      testCmd: "",
      checks: [],
      supports: { ...NONE },
      shadowLinks: [],
    };
  }

  if (configured !== undefined) base.checks = sanitizeConfigured(configured, repoPath);
  return base;
}

/** Checks of `profile` that apply to `phase`. */
export function checksForPhase(checks: RepoCheck[], phase: "commit" | "deploy"): RepoCheck[] {
  return checks.filter((ck) => !ck.phases || ck.phases.includes(phase));
}
