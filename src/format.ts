import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import prettier from "prettier";
import { git } from "./git";

/**
 * Hardcoded Prettier options for chong. Bias toward minimal merge-conflict
 * surface: trailing commas everywhere (so adding a parameter doesn't modify
 * the line above it), conservative wrapping, LF endings.
 *
 * Not user-configurable. We deliberately ignore .prettierrc and
 * package.json#prettier — every chong CL goes through the same formatter so
 * `git log` history is consistent across the org.
 */
const OPTIONS: prettier.Options = {
  trailingComma: "all",
  semi: true,
  singleQuote: false,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  endOfLine: "lf",
  proseWrap: "preserve",
};

const PARSER_BY_EXT: Record<string, prettier.BuiltInParserName> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".js": "babel",
  ".jsx": "babel",
  ".mjs": "babel",
  ".cjs": "babel",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "mdx",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".graphql": "graphql",
  ".gql": "graphql",
};

export type FormatResult = {
  formatted: string[];
  skipped: string[];
};

/**
 * Format every file changed since the merge-base with `origin/main` in the
 * given worktree. Writes back in place. Files with unsupported extensions
 * are silently skipped. Files that are already correctly formatted are no-ops.
 */
export async function formatChangedSinceMain(cwd: string): Promise<FormatResult> {
  let base: string;
  try {
    base = await git.mergeBase("origin/main", "HEAD", cwd);
  } catch {
    // No origin/main yet — fall back to HEAD's parent. If even that fails,
    // there's nothing to compare against, so nothing to format.
    try {
      base = await git.mergeBase("HEAD~1", "HEAD", cwd);
    } catch {
      return { formatted: [], skipped: [] };
    }
  }

  const files = await git.diffNames(base, cwd);
  const formatted: string[] = [];
  const skipped: string[] = [];

  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    const parser = PARSER_BY_EXT[ext];
    if (!parser) {
      skipped.push(rel);
      continue;
    }
    const abs = join(cwd, rel);
    let source: string;
    try {
      source = await readFile(abs, "utf8");
    } catch {
      continue; // deleted between diff listing and read
    }
    let result: string;
    try {
      result = await prettier.format(source, { ...OPTIONS, parser });
    } catch (e) {
      // syntax error in source — let it through; the user's typecheck will catch it.
      skipped.push(rel);
      continue;
    }
    if (result !== source) {
      await writeFile(abs, result, "utf8");
      formatted.push(rel);
    }
  }

  return { formatted, skipped };
}
