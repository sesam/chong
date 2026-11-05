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

/**
 * Conflict / agent-fail inject blocking is implemented in reconcileLocalMain
 * (returns blockShas from the conflicted SHA onward). That path needs a real
 * git fixture; the contract to protect is: a conflict result MUST carry
 * blockShas, same as partial-apply / empty-pick — otherwise the 15s poll
 * re-spawns agents forever. Documented here so a future refactor doesn't drop it.
 */
describe("inject conflict block contract", () => {
  test("ReconcileResult conflict shape expects blockShas (type-level reminder)", () => {
    const conflict: {
      action: "conflict";
      blockShas?: string[];
      message: string;
    } = {
      action: "conflict",
      message: "cherry-pick abc1234 conflicted — left origin/main untouched",
      blockShas: ["abc1234deadbeef"],
    };
    expect(conflict.blockShas?.length).toBeGreaterThan(0);
  });
});
