import { describe, expect, test } from "bun:test";
import { cherryPickPatchPreserved } from "./checks";

describe("cherryPickPatchPreserved", () => {
  test("matching ids are preserved", () => {
    expect(cherryPickPatchPreserved("abc", "abc")).toBe(true);
  });

  test("mismatched ids are not preserved (partial apply)", () => {
    expect(cherryPickPatchPreserved("abc", "def")).toBe(false);
  });

  test("missing either id is not preserved", () => {
    expect(cherryPickPatchPreserved(null, "abc")).toBe(false);
    expect(cherryPickPatchPreserved("abc", null)).toBe(false);
    expect(cherryPickPatchPreserved(null, null)).toBe(false);
    expect(cherryPickPatchPreserved("", "abc")).toBe(false);
  });
});
