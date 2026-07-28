import { describe, expect, test } from "bun:test";
import {
  addedLineNumbers,
  findUntranslated,
  isExcludedPath,
  isScannable,
  localeSignal,
} from "./i18n-scan";

describe("localeSignal", () => {
  test("flags accented (Slovenian) copy", () => {
    expect(localeSignal("Želite sončno elektrarno?")).toBe(true);
    expect(localeSignal("Optimizacija stroškov")).toBe(true);
    expect(localeSignal("Električne inštalacije — pameten dom")).toBe(true);
  });

  test("flags diacritic-free Slovenian via function words", () => {
    expect(localeSignal("(odvisno od obsega)")).toBe(true);
    expect(localeSignal("nad 100 m²")).toBe(true);
  });

  test("does not flag English UI copy or code tokens", () => {
    expect(localeSignal("Cost estimate")).toBe(false);
    expect(localeSignal("flex justify-content-between")).toBe(false);
    expect(localeSignal("Investment in your home")).toBe(false); // "in" is not in the SL list
    expect(localeSignal("mt-2 mb-5")).toBe(false);
    expect(localeSignal("od")).toBe(false); // lone token, not a phrase
    expect(localeSignal("")).toBe(false);
    expect(localeSignal("€1,000")).toBe(false);
  });

  test("does not treat non-letter symbols as accents (×, ÷, ², €, —)", () => {
    expect(localeSignal("1376×768")).toBe(false);
    expect(localeSignal("long / short × 100")).toBe(false);
    expect(localeSignal("12 ÷ 4")).toBe(false);
    expect(localeSignal("area in m²")).toBe(false);
    expect(localeSignal("price — total")).toBe(false);
  });
});

describe("findUntranslated", () => {
  test("flags a hardcoded JS string and skips the t()-wrapped one", () => {
    const src = [
      "function questionText(k) {",
      "  switch (k) {",
      "    case 'a':",
      "      return 'Želite standardni sistem?'", // line 4, hardcoded
      "    case 'b':",
      "      return t('Modern installations')", // wrapped, English → not flagged
      "  }",
      "}",
    ].join("\n");
    const found = findUntranslated(src, "QuestionBox.js");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
    expect(found[0]?.text).toContain("Želite");
  });

  test("ignores strings inside comments", () => {
    const src = "// Prezračevanje z rekuperacijo\nconst x = 'flex'";
    expect(findUntranslated(src, "a.js")).toHaveLength(0);
  });

  test("handles template literals and skips ${} interpolation", () => {
    const src = "addLine(`Hlajenje — ${units} enot`, cost)";
    const found = findUntranslated(src, "a.js");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("Hlajenje");
  });

  test("does not desync on a regex literal containing a quote", () => {
    // The apostrophe inside /['"]/ must not open a phantom string that swallows
    // the following real code as one giant 'string'.
    const src = ["const re = /['\"]/g", "const ok = bar(x) / 2", "const n = 5"].join("\n");
    expect(findUntranslated(src, "a.js")).toHaveLength(0);
  });

  test("treats division after a value as division, not a regex", () => {
    const src = "const ratio = total / count\nconst label = 'Cena na m²'";
    // 'Cena na m²' has no accented letter and no SL function word → not flagged,
    // but crucially the `/` must not start a regex that eats the next line.
    expect(findUntranslated(src, "a.js")).toHaveLength(0);
  });

  test("rejects code captured as a string after a lexer mis-read", () => {
    // Even if a desync slips through, a value carrying code syntax is dropped.
    const src = "const x = 'const fp = scene.getObjectByName() => bar'";
    expect(findUntranslated(src, "a.js")).toHaveLength(0);
  });

  test("a single-quoted string cannot span a newline (bails at the line)", () => {
    const src = "const a = 'Trajnost\nconst sONČNO = 'Sončna elektrarna'";
    // The first quote is bogus; the scanner must recover and still find the real one.
    const found = findUntranslated(src, "a.js");
    expect(found.some((f) => f.text.includes("Sončna"))).toBe(true);
  });

  test("scans Vue <script> blocks with correct line numbers", () => {
    const src = [
      "<template>",
      "  <p>{{ title }}</p>",
      "</template>",
      "",
      "<script setup>",
      "const s = 'Sončna elektrarna'",
      "</script>",
    ].join("\n");
    const found = findUntranslated(src, "Comp.vue");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(6);
  });

  test("flags raw text nodes in a Vue template", () => {
    const src = "<template>\n  <p>Optimizacija stroškov</p>\n</template>";
    const found = findUntranslated(src, "Comp.vue");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });
});

describe("localeSignal — narrowed to Latin script", () => {
  test("does not flag Greek/math letters used as symbols (Σ, Δ, µ)", () => {
    expect(localeSignal("Σ rooms")).toBe(false);
    expect(localeSignal("max|Δ|≈ %")).toBe(false);
    expect(localeSignal("µ value")).toBe(false);
  });
  test("still flags accented Latin copy", () => {
    expect(localeSignal("Površina objekta")).toBe(true);
  });
});

describe("findUntranslated — suppressions", () => {
  test("skips strings inside a const object/array data table", () => {
    const src = [
      "const OBCINE = [",
      "  { name: 'Ajdovščina' },", // data table → skipped
      "]",
      "const title = 'Dobrodošli'", // scalar const → still flagged
    ].join("\n");
    const found = findUntranslated(src, "data.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("Dobrodošli");
    expect(found[0]?.line).toBe(4);
  });

  test("still flags copy passed to a call inside a const (not a data literal)", () => {
    const src = "const label = format('Sončna elektrarna')";
    const found = findUntranslated(src, "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("Sončna");
  });

  test("skips console.* arguments (incl. non-first args)", () => {
    const src = "console.log('[Tag]', 'Napaka pri nalaganju', x)";
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("skips optional-call console.table?.() arguments", () => {
    const src =
      "console.table?.(rows.map((p) => ({ 'površina parcele (m²)': p.a, 'št. rab': p.n })))";
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("treats this.t('…') / this.$t('…') as wrapped", () => {
    const src = [
      "function f() {",
      "  return this.t('Življenjski slog') + this.$t('Otroška soba')",
      "}",
    ].join("\n");
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("skips case labels and equality comparisons (lookup keys, not copy)", () => {
    const src = [
      "function f(v) {",
      "  switch (v) {",
      "    case 'Začetna faza, raziskujem možnosti':",
      "      return 1",
      "  }",
      "  if (v === 'Aktivno iščem parcelo') return 2",
      "  return v !== 'Imam parcelo, želim graditi' ? 3 : 4",
      "}",
    ].join("\n");
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("skips bracket member-access keys like props['POVRŠINA']", () => {
    const src = "function a(props) { return Number(props.POVRSINA ?? props['POVRŠINA']) }";
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("still flags array-literal elements (a `[` after an operator is not access)", () => {
    const src = "function f() { return ['Sončna elektrarna'] }";
    expect(findUntranslated(src, "a.ts")).toHaveLength(1);
  });

  test("treats Object.freeze(…) as a transparent const data table", () => {
    const src = [
      "const DEFAULTS = Object.freeze({",
      "  roof: 'dvokapne ali ravne strehe',",
      "})",
    ].join("\n");
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("suppresses the unwrapped twin of a string wrapped in t() elsewhere in the file", () => {
    const src = [
      "const LOOKUP = [",
      "  { base: 'Otroška soba', tr: () => t('Otroška soba') },",
      "]",
      "const other = 'Kopalnica in spalnica ter hodnik'", // not wrapped anywhere → flagged
    ].join("\n");
    const found = findUntranslated(src, "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("Kopalnica");
  });

  test("a `// t('…')` marker comment counts as wrapped-elsewhere", () => {
    const src = [
      "// t('Začetna faza, raziskujem možnosti')",
      "const v = 'Začetna faza, raziskujem možnosti'",
    ].join("\n");
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("chong-i18n-disable-file pragma silences the whole file", () => {
    const src = [
      "// chong-i18n-disable-file — LLM context, not UI",
      "const s = 'Proračun projekta presežen'",
    ].join("\n");
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("chong-i18n-disable-next-line / -line pragmas silence single lines", () => {
    const src = [
      "// chong-i18n-disable-next-line ops diagnostic",
      "const a = 'Konfiguracija hiše ni več zelena'",
      "const b = 'Nezazidljivo zemljišče' // chong-i18n-disable-line",
      "const c = 'Sončna elektrarna'",
    ].join("\n");
    const found = findUntranslated(src, "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("Sončna");
  });

  test("skips lookup / probe arguments (fieldAfter, startsWith, includes, replace)", () => {
    const src = [
      "fieldAfter(cover, 'številka lokacijske informacije')",
      "if (eup.startsWith('ŽUV-')) return true",
      "if (hay.includes('idp zupan selič - pdf app')) return true",
      ".replace(/številka\\s*\\n\\s*informacije/gi, 'številka lokacijske informacije')",
      "new RegExp('(?:^|\\\\n)[a-zčšž]', 'i')",
    ].join("\n");
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });
});

describe("findUntranslated — advisories", () => {
  test("flags a dynamic t(variable) key", () => {
    const src = "const s = t(messageKey)";
    const found = findUntranslated(src, "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("dynamic");
    expect(found[0]?.text).toBe("messageKey");
  });

  test("does not flag t('literal') as dynamic", () => {
    const src = "const s = t('Cost estimate')";
    expect(findUntranslated(src, "a.ts")).toHaveLength(0);
  });

  test("classifies concatenated user text as concat", () => {
    const src = "const s = 'Vaša hiša: ' + area + ' m²'";
    const found = findUntranslated(src, "a.ts");
    expect(found.some((f) => f.kind === "concat" && f.text.includes("Vaša"))).toBe(true);
  });

  test("flags a stray \\n inside copy and de-mangles the text", () => {
    const src = "function f(){ return 'Ključni\\npoudarek' }";
    const found = findUntranslated(src, "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("Ključni poudarek");
    expect(found[0]?.escape).toBe(true);
  });

  test("a file with // t('…') marker comments stops getting dynamic-key advisories", () => {
    const src = ["// t('The email field is required')", "const msg = t(errors.email)"].join("\n");
    expect(findUntranslated(src, "Login.vue")).toHaveLength(0);
  });

  test("honors eslint-disable no-restricted-syntax for dynamic t(variable) advisories", () => {
    const src = [
      "/* eslint-disable no-restricted-syntax -- dynamic element catalog codes */",
      "const a = t(code)",
      "/* eslint-enable no-restricted-syntax */",
      "const b = t(otherKey)",
      "// eslint-disable-next-line no-restricted-syntax",
      "const c = t(thirdKey)",
    ].join("\n");
    const found = findUntranslated(src, "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("otherKey");
  });
});

describe("isExcludedPath — Debug* tooling", () => {
  test("excludes Debug* folders and files", () => {
    expect(isExcludedPath("src/features/DebugProjects/i2FootprintClusters.js")).toBe(true);
    expect(isExcludedPath("src/features/DebugRoof/DebugFloorCards.vue")).toBe(true);
    expect(isExcludedPath("src/features/DebugCo2Calculator/GeometryStep.vue")).toBe(true);
  });
  test("does not exclude normal feature folders", () => {
    expect(isExcludedPath("src/features/Journal/BuildabilityReportTab.vue")).toBe(false);
  });
});

describe("addedLineNumbers", () => {
  test("collects added new-side line numbers per file", () => {
    const diff = [
      "diff --git a/x.js b/x.js",
      "--- a/x.js",
      "+++ b/x.js",
      "@@ -10,0 +11,2 @@",
      "+const a = 'Želite'",
      "+const b = 2",
    ].join("\n");
    const map = addedLineNumbers(diff);
    expect([...(map.get("x.js") ?? [])]).toEqual([11, 12]);
  });
});

describe("isScannable", () => {
  test("accepts source files, rejects others", () => {
    expect(isScannable("a.vue")).toBe(true);
    expect(isScannable("b.ts")).toBe(true);
    expect(isScannable("c.po")).toBe(false);
    expect(isScannable("d.json")).toBe(false);
    expect(isScannable("e.md")).toBe(false);
    expect(isScannable("f.mjs")).toBe(false);
  });
});

describe("isExcludedPath", () => {
  test("excludes tests, scripts, fixtures, and data files", () => {
    expect(isExcludedPath("tests/unit/siteMetadata.test.ts")).toBe(true);
    expect(isExcludedPath("src/features/Foo/__tests__/foo.js")).toBe(true);
    expect(isExcludedPath("src/Foo.spec.tsx")).toBe(true);
    expect(isExcludedPath("scripts/build-renders.mjs")).toBe(true);
    expect(isExcludedPath("src/__fixtures__/sample.js")).toBe(true);
    expect(isExcludedPath("src/features/Co2/co2Data.js")).toBe(true);
    expect(isExcludedPath("src/data/mock-data.ts")).toBe(true);
    expect(isExcludedPath("src/Button.stories.ts")).toBe(true);
    expect(isExcludedPath("src/types/api.d.ts")).toBe(true);
  });

  test("excludes public/ and */data/ (static assets / generated geo fixtures)", () => {
    expect(isExcludedPath("public/opnagent/data/test-plots.js")).toBe(true);
    expect(isExcludedPath("public/opnagent/data/muni.js")).toBe(true);
    expect(isExcludedPath("src/features/ParcelSupport/data/roster.js")).toBe(true);
  });

  test("keeps real product source (incl. metadata, not a data file)", () => {
    expect(isExcludedPath("src/features/HeatingCooling/QuestionBox.vue")).toBe(false);
    expect(isExcludedPath("src/features/Journal/siteMetadata.js")).toBe(false);
    expect(isExcludedPath("src/utils/costBreakdownCalculator.js")).toBe(false);
  });
});
