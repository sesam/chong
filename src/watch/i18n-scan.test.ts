import { describe, expect, test } from "bun:test";
import { addedLineNumbers, findUntranslated, isScannable, localeSignal } from "./i18n-scan";

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
  });
});
