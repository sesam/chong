import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  blankComments,
  candidatePaths,
  collectSpecifiers,
  formatUnresolvedSummary,
  isCheckable,
  readAliasMap,
  scanUnresolvedImports,
} from "./unresolved-imports";

const ALIASES = [{ prefix: "@/", targets: ["src/"] }];

function repoFixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "chong-imports-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

describe("blankComments", () => {
  test("blanks line and block comments but keeps offsets and newlines", () => {
    const src = "const a = 1; // gone\nconst b = 2;";
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("gone");
  });

  test("leaves string contents alone — the specifier lives in one", () => {
    const src = `import x from "@/real/path.js";`;
    expect(blankComments(src)).toBe(src);
  });

  test("does not treat // inside a string as a comment", () => {
    const src = `const u = "https://example.com"; import x from "@/a.js";`;
    expect(blankComments(src)).toContain("@/a.js");
    expect(blankComments(src)).toContain("https://example.com");
  });

  test("handles an escaped quote inside a string", () => {
    const src = `const s = "he said \\"hi\\""; import x from "@/a.js";`;
    expect(blankComments(src)).toContain("@/a.js");
  });
});

describe("collectSpecifiers", () => {
  test("finds static, side-effect, re-export and dynamic imports", () => {
    const src = [
      `import a from "@/one.js";`,
      `import "@/two.css";`,
      `export { b } from "@/three.js";`,
      `const c = await import("@/four.js");`,
      "import {",
      "  d,",
      `} from "@/five.js";`,
    ].join("\n");
    const specs = collectSpecifiers(src).map((s) => s.specifier);
    expect(specs).toContain("@/one.js");
    expect(specs).toContain("@/two.css");
    expect(specs).toContain("@/three.js");
    expect(specs).toContain("@/four.js");
    expect(specs).toContain("@/five.js");
  });

  test("marks dynamic imports as dynamic", () => {
    const specs = collectSpecifiers(`const x = import("@/lazy.js")`);
    expect(specs[0]).toMatchObject({ specifier: "@/lazy.js", kind: "dynamic" });
  });

  test("reports the right line number", () => {
    const src = ["// header", "", `import a from "@/one.js";`].join("\n");
    expect(collectSpecifiers(src)[0]?.line).toBe(3);
  });

  test("IGNORES an import written inside a comment", () => {
    // The regression this whole gate nearly tripped over: doc comments in the LynxCraft repo
    // literally contain `import('@/…')` as prose. Reporting those made the first ad-hoc
    // version of this check produce two false positives out of two.
    const src = [
      "// an `@vite-ignore`d `import('@/…')` ships the alias verbatim",
      "/* see import('@/also/not/real.js') for why */",
      `import real from "@/actual.js";`,
    ].join("\n");
    const specs = collectSpecifiers(src).map((s) => s.specifier);
    expect(specs).toEqual(["@/actual.js"]);
  });

  test("tolerates a @vite-ignore comment inside the import() call itself", () => {
    const specs = collectSpecifiers(`import(/* @vite-ignore */ "@/dyn.js")`);
    expect(specs.map((s) => s.specifier)).toContain("@/dyn.js");
  });
});

describe("isCheckable", () => {
  test("checks aliased and relative specifiers", () => {
    expect(isCheckable("@/a.js", ALIASES)).toBe(true);
    expect(isCheckable("./a.js", ALIASES)).toBe(true);
    expect(isCheckable("../a.js", ALIASES)).toBe(true);
  });

  test("skips bare packages, template holes and URLs", () => {
    expect(isCheckable("vue", ALIASES)).toBe(false);
    expect(isCheckable("@vueuse/core", ALIASES)).toBe(false);
    expect(isCheckable("@/locales/${lang}.json", ALIASES)).toBe(false);
    expect(isCheckable("https://cdn.example.com/x.js", ALIASES)).toBe(false);
    expect(isCheckable("", ALIASES)).toBe(false);
  });
});

describe("candidatePaths", () => {
  test("expands an alias and tries the usual extensions", () => {
    const c = candidatePaths("@/utils/thing", "src/app.js", ALIASES);
    expect(c).toContain("src/utils/thing.js");
    expect(c).toContain("src/utils/thing.ts");
    expect(c).toContain("src/utils/thing.vue");
    expect(c).toContain(path.join("src/utils/thing", "index.js"));
  });

  test("resolves relative specifiers against the importing file", () => {
    const c = candidatePaths("./sibling.js", "src/deep/nested/app.js", ALIASES);
    expect(c).toContain("src/deep/nested/sibling.js");
  });

  test("strips a Vite query suffix", () => {
    const c = candidatePaths("@/assets/logo.svg?url", "src/app.js", ALIASES);
    expect(c).toContain("src/assets/logo.svg");
  });
});

describe("readAliasMap", () => {
  test("reads tsconfig paths, including a jsonc-style file with comments", () => {
    const root = repoFixture({
      "tsconfig.json": `{
        // a comment JSON.parse would reject
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"], "~~/*": ["packages/*"] },
        }
      }`,
    });
    const map = readAliasMap(root);
    expect(map.find((a) => a.prefix === "@/")?.targets).toEqual(["src/"]);
    expect(map.find((a) => a.prefix === "~~/")?.targets).toEqual(["packages/"]);
  });

  test("falls back to @/ -> src/ when there is no tsconfig", () => {
    expect(readAliasMap(repoFixture({}))).toEqual([{ prefix: "@/", targets: ["src/"] }]);
  });
});

describe("scanUnresolvedImports", () => {
  test("reports a dangling lazy import and says nothing about the good ones", () => {
    const root = repoFixture({
      "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}`,
      "src/exists.js": "export const a = 1;",
      "src/router.js": [
        `import { a } from "@/exists.js";`,
        `const good = () => import("@/exists.js");`,
        `const bad = () => import("@/deleted/page.vue");`,
      ].join("\n"),
    });
    const { findings, specifiersChecked } = scanUnresolvedImports(root, ["src"]);
    expect(specifiersChecked).toBe(3);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "src/router.js",
      line: 3,
      specifier: "@/deleted/page.vue",
      kind: "dynamic",
    });
  });

  test("catches the deletion-sweep case: importer untouched, target removed", () => {
    // Nothing in `consumer.js` changed; the commit deleted `pricingService.js`. A
    // changed-files gate sees a clean diff for this file and passes.
    const root = repoFixture({
      "src/consumer.js": `import { compute } from "@/features/Pricing/pricingService.js";`,
    });
    const { findings } = scanUnresolvedImports(root, ["src"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("static");
  });

  test("resolves extensionless and index imports without flagging them", () => {
    const root = repoFixture({
      "src/utils/thing.ts": "export const t = 1;",
      "src/feature/index.js": "export const f = 1;",
      "src/app.js": [`import { t } from "@/utils/thing";`, `import { f } from "@/feature";`].join(
        "\n",
      ),
    });
    expect(scanUnresolvedImports(root, ["src"]).findings).toEqual([]);
  });

  test("ignores node_modules and build output", () => {
    const root = repoFixture({
      "src/app.js": "export const a = 1;",
      "node_modules/pkg/index.js": `import x from "@/nope.js";`,
      "dist/bundle.js": `import y from "@/also-nope.js";`,
    });
    expect(scanUnresolvedImports(root, ["src", "node_modules", "dist"]).findings).toEqual([]);
  });

  test("a clean repo yields no findings", () => {
    const root = repoFixture({
      "src/a.js": `import { b } from "@/b.js";`,
      "src/b.js": "export const b = 1;",
    });
    const { findings, filesScanned } = scanUnresolvedImports(root, ["src"]);
    expect(findings).toEqual([]);
    expect(filesScanned).toBe(2);
  });
});

describe("formatUnresolvedSummary", () => {
  test("lists findings and truncates with a count", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      file: `src/f${i}.js`,
      line: i + 1,
      specifier: `@/missing${i}.js`,
      kind: "dynamic" as const,
    }));
    const out = formatUnresolvedSummary(many, 12);
    expect(out).toContain("src/f0.js:1");
    expect(out).toContain("… +3 more");
  });
});
