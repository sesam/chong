/**
 * Pre-deploy gate: find import specifiers that resolve to no file on disk.
 *
 * Why this exists as its own gate rather than being left to the bundler: a **lazy**
 * `import()` is only resolved when the chunk is first requested, so `vite build` happily
 * emits a bundle whose route chunk cannot load. The failure surfaces as a blank page on
 * navigation, in production, and neither the build nor the unit tests catch it. A repo-wide
 * filesystem existence check does, and costs well under a second.
 *
 * It scans the WHOLE tree, not the changed files. That is the entire point: the commit that
 * breaks things deletes or renames file A, while the now-dangling import sits in file B,
 * which the diff does not mention. A changed-files gate would miss precisely the case this
 * is for (a deletion sweep).
 *
 * Deliberately conservative — a false positive blocks a deploy, so anything it cannot
 * resolve *confidently* is skipped rather than reported:
 *   - comments are blanked before scanning (prose like `import('@/…')` in a doc comment is
 *     the most common false positive, and cost a real audit an hour)
 *   - only alias-mapped and relative specifiers are checked; bare package names are left to
 *     the package manager
 *   - dynamic specifiers containing a template hole are skipped, since their target is not
 *     knowable statically
 *   - Vite query suffixes (`?url`, `?raw`, `?worker`) are stripped before resolving
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Extensions we scan for imports. */
const SCANNED_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".jsx",
  ".vue",
]);

/**
 * Extensions tried when a specifier has none. Order matters only for speed; a specifier
 * resolving to several of these is still resolved.
 */
const RESOLVE_EXTS = [
  "",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".jsx",
  ".vue",
  ".json",
  ".css",
  ".scss",
  ".svg",
];

const INDEX_BASENAMES = ["index.js", "index.ts", "index.mjs", "index.tsx", "index.vue"];

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  "graphify-out",
]);

export type UnresolvedImport = {
  /** Repo-relative file holding the import. */
  file: string;
  line: number;
  specifier: string;
  /** `static` for `import x from '…'`, `dynamic` for `import('…')`. */
  kind: "static" | "dynamic";
};

export type AliasMap = Array<{ prefix: string; targets: string[] }>;

/**
 * Blank out comments, preserving byte offsets and newlines so reported line numbers stay
 * correct. String and template contents are left intact — the specifier lives in one.
 *
 * Known limit, stated rather than hidden: a regex literal containing `//` (e.g.
 * `/https:\/\//`) can be misread as starting a line comment, blanking the rest of that
 * line. That direction of error hides an import (a missed finding), never invents one — the
 * safe way round for a gate that blocks deploys.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";

  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : "";

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") state = "code";
      else out[i] = " ";
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        state = "code";
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }

    // Inside a string/template: honour escapes, exit on the matching quote.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (
      (state === "single" && c === "'") ||
      (state === "double" && c === '"') ||
      (state === "template" && c === "`")
    ) {
      state = "code";
    }
    i += 1;
  }

  return out.join("");
}

/**
 * Static / re-export / side-effect imports.
 *
 * Two details that are load-bearing and were both caught by the tests:
 *   - the from-clause group is `??` (LAZY optional). Greedy `?` prefers to MATCH it, so at
 *     `import "@/a.css";` it happily ran past the newline to the next statement's `from`,
 *     swallowing the side-effect import and blaming the wrong line.
 *   - the clause body is `[^'"`;]*?`, not `[\s\S]*?`, so a match can never cross a string
 *     or a statement boundary. Newlines and braces are still allowed, which is what lets a
 *     multi-line `import {\n  a,\n} from '…'` match.
 */
const STATIC_RE =
  /\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s*)??["']([^"'`]+)["']|\bimport\s*["']([^"'`]+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?["']([^"'`]+)["']\s*\)/g;

/** Extract every statically-knowable import specifier, with 1-indexed line numbers. */
export function collectSpecifiers(
  src: string,
): Array<{ specifier: string; line: number; kind: "static" | "dynamic" }> {
  const code = blankComments(src);
  const found: Array<{ specifier: string; line: number; kind: "static" | "dynamic" }> = [];

  // Precompute line starts once — cheaper than counting newlines per match.
  const lineStarts: number[] = [0];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  for (const re of [DYNAMIC_RE, STATIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(code);
    while (m !== null) {
      const spec = m[1] ?? m[2];
      if (spec) {
        found.push({
          specifier: spec,
          line: lineOf(m.index),
          kind: re === DYNAMIC_RE ? "dynamic" : "static",
        });
      }
      m = re.exec(code);
    }
  }
  return found;
}

/**
 * Alias prefixes from the repo's tsconfig `compilerOptions.paths`, falling back to the
 * near-universal `@/* -> src/*` when there is no usable tsconfig.
 *
 * jsonc-tolerant: tsconfigs routinely carry comments and trailing commas, which
 * `JSON.parse` rejects — reusing `blankComments` here rather than adding a dependency.
 */
export function readAliasMap(repoPath: string): AliasMap {
  const fallback: AliasMap = [{ prefix: "@/", targets: ["src/"] }];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const p = path.join(repoPath, name);
    if (!existsSync(p)) continue;
    try {
      const raw = blankComments(readFileSync(p, "utf8")).replace(/,(\s*[}\]])/g, "$1");
      const cfg = JSON.parse(raw);
      const base = cfg?.compilerOptions?.baseUrl ?? ".";
      const paths = cfg?.compilerOptions?.paths;
      if (!paths || typeof paths !== "object") continue;
      const map: AliasMap = [];
      for (const [key, value] of Object.entries(paths)) {
        if (!Array.isArray(value) || value.length === 0) continue;
        const prefix = key.endsWith("*") ? key.slice(0, -1) : key;
        const targets = (value as string[])
          .filter((t) => typeof t === "string")
          .map((t) => path.join(base, t.endsWith("*") ? t.slice(0, -1) : t));
        if (targets.length > 0) map.push({ prefix, targets });
      }
      if (map.length > 0) return map;
    } catch {
      /* unreadable tsconfig — fall through to the default */
    }
  }
  return fallback;
}

/** Strip a Vite query/fragment suffix (`?url`, `?raw&inline`) before resolving. */
function stripQuery(spec: string): string {
  const q = spec.search(/[?#]/);
  return q === -1 ? spec : spec.slice(0, q);
}

/**
 * True when the specifier is one we can check. Bare package names belong to the package
 * manager, and a template hole has no single statically-knowable target.
 */
export function isCheckable(spec: string, aliases: AliasMap): boolean {
  if (!spec || spec.includes("${")) return false;
  if (spec.startsWith("data:") || spec.startsWith("http:") || spec.startsWith("https:")) {
    return false;
  }
  if (spec.startsWith("./") || spec.startsWith("../")) return true;
  return aliases.some((a) => spec.startsWith(a.prefix) && spec.length > a.prefix.length);
}

/** Candidate on-disk paths for a checkable specifier, repo-relative. */
export function candidatePaths(spec: string, fromFile: string, aliases: AliasMap): string[] {
  const bare = stripQuery(spec);
  const roots: string[] = [];

  if (bare.startsWith("./") || bare.startsWith("../")) {
    roots.push(path.normalize(path.join(path.dirname(fromFile), bare)));
  } else {
    for (const a of aliases) {
      if (!bare.startsWith(a.prefix)) continue;
      const rest = bare.slice(a.prefix.length);
      for (const t of a.targets) roots.push(path.normalize(path.join(t, rest)));
    }
  }

  const out: string[] = [];
  for (const root of roots) {
    for (const ext of RESOLVE_EXTS) out.push(root + ext);
    for (const idx of INDEX_BASENAMES) out.push(path.join(root, idx));
  }
  return out;
}

function listSourceFiles(repoPath: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(path.join(repoPath, dir));
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") && name !== ".") continue;
    const rel = dir === "." ? name : path.join(dir, name);
    const abs = path.join(repoPath, rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIPPED_DIRS.has(name)) continue;
      listSourceFiles(repoPath, rel, acc);
      continue;
    }
    if (SCANNED_EXTS.has(path.extname(name))) acc.push(rel);
  }
}

/**
 * Scan the repo for import specifiers with no file behind them.
 *
 * @param repoPath worktree root
 * @param roots directories to scan (default: every source dir except the skip list)
 */
export function scanUnresolvedImports(
  repoPath: string,
  roots: string[] = ["src", "tests", "scripts"],
): { findings: UnresolvedImport[]; filesScanned: number; specifiersChecked: number } {
  const aliases = readAliasMap(repoPath);
  const files: string[] = [];
  for (const root of roots) {
    // The skip list has to be applied to the roots too, not just to recursion — otherwise
    // passing `node_modules` explicitly walks it.
    if (SKIPPED_DIRS.has(root)) continue;
    if (existsSync(path.join(repoPath, root))) listSourceFiles(repoPath, root, files);
  }

  const findings: UnresolvedImport[] = [];
  let specifiersChecked = 0;

  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(path.join(repoPath, file), "utf8");
    } catch {
      continue;
    }
    if (!src.includes("import")) continue;

    for (const { specifier, line, kind } of collectSpecifiers(src)) {
      if (!isCheckable(specifier, aliases)) continue;
      specifiersChecked += 1;
      const candidates = candidatePaths(specifier, file, aliases);
      const hit = candidates.some((c) => {
        const abs = path.join(repoPath, c);
        try {
          return statSync(abs).isFile();
        } catch {
          return false;
        }
      });
      if (!hit) findings.push({ file, line, specifier, kind });
    }
  }

  return { findings, filesScanned: files.length, specifiersChecked };
}

export function formatUnresolvedSummary(findings: UnresolvedImport[], limit = 12): string {
  const lines = findings
    .slice(0, limit)
    .map((f) => `${f.file}:${f.line}  ${f.kind} import '${f.specifier}' → no such file`);
  if (findings.length > limit) lines.push(`… +${findings.length - limit} more`);
  return lines.join("\n");
}
