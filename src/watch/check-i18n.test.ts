import { describe, expect, test } from "bun:test";
import { addedLineLooksLikeI18nCode } from "./checks";

describe("addedLineLooksLikeI18nCode", () => {
  test("matches real t() / useT / i18n hits", () => {
    expect(addedLineLooksLikeI18nCode("+  return t('Hello')")).toBe(true);
    expect(addedLineLooksLikeI18nCode('+  return t("Hello")')).toBe(true);
    expect(addedLineLooksLikeI18nCode("+  return t(`Hello`)")).toBe(true);
    expect(addedLineLooksLikeI18nCode("+    {{ t('Foo') }}")).toBe(true);
    expect(addedLineLooksLikeI18nCode("+  title: t('Bar'),")).toBe(true);
    expect(addedLineLooksLikeI18nCode("+  const { t } = useT('journal')")).toBe(true);
    expect(addedLineLooksLikeI18nCode("+  // chong-i18n-disable-next-line")).toBe(true);
    expect(addedLineLooksLikeI18nCode("+  something about i18n tooling")).toBe(true);
    expect(addedLineLooksLikeI18nCode("+  label = $t('legacy')")).toBe(true);
  });

  test("rejects it( / import( / get( / split( / test( / format(", () => {
    expect(
      addedLineLooksLikeI18nCode(
        "+  it('never blanket-sources .env.local — it extracts only the canary key', () => {",
      ),
    ).toBe(false);
    expect(
      addedLineLooksLikeI18nCode(
        "+const { SAVED_STATE_VERSION } = await import('@/features/Journal/plotProtectionsState.js')",
      ),
    ).toBe(false);
    expect(
      addedLineLooksLikeI18nCode('+            pages = [p for p in pages if p.get("type") == "page"]'),
    ).toBe(false);
    expect(addedLineLooksLikeI18nCode("+  const parts = path.split('/')")).toBe(false);
    expect(addedLineLooksLikeI18nCode("+  test('unit case', () => {})")).toBe(false);
    expect(addedLineLooksLikeI18nCode("+  msg = format('hello %s', name)")).toBe(false);
  });
});
