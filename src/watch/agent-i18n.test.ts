import { describe, expect, test } from "bun:test";
import { i18nGatePrompt, i18nResolvePrompt } from "./agent";
import { isAgentableI18nFailure } from "./checks";

describe("isAgentableI18nFailure", () => {
  test("matches empty msgstr FIX output", () => {
    expect(
      isAgentableI18nFailure(
        "[i18n] FIX (update — 34 empty msgstr in .en.po / .sl.po):\n  shared.sl.po:111",
      ),
    ).toBe(true);
  });

  test("matches identical en/sl FIX output", () => {
    expect(
      isAgentableI18nFailure(
        "[i18n] FIX (update — 41 identical en/sl msgstr; en and sl should differ):",
      ),
    ).toBe(true);
  });

  test("matches allowlist action hint", () => {
    expect(
      isAgentableI18nFailure(
        "add intentional matches to scripts/i18n-identical-msgstr-allowlist.json",
      ),
    ).toBe(true);
  });

  test("ignores unrelated failures", () => {
    expect(isAgentableI18nFailure("Error: Cannot find module 'foo'")).toBe(false);
  });
});

describe("i18n agent prompts", () => {
  test("gate lists empty msgstr and allowlist as SAFE cases", () => {
    const p = i18nGatePrompt("summary here");
    expect(p).toContain("empty msgstr");
    expect(p).toContain("i18n-identical-msgstr-allowlist.json");
    expect(p).toContain("VERDICT: SAFE");
  });

  test("resolve requires i18n exit 0 and allowlist path", () => {
    const p = i18nResolvePrompt("summary here", "pnpm i18n");
    expect(p).toContain("until it exits 0");
    expect(p).toContain("pnpm i18n");
    expect(p).toContain("i18n-identical-msgstr-allowlist.json");
  });
});
