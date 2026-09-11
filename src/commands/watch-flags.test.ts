import { describe, expect, test } from "bun:test";
import { parseArgs } from "../util";

/**
 * `cmdWatch` (src/commands/watch.ts) computes
 *   const autoInject = flags["no-auto-inject"] !== true;
 * the same pattern as the pre-existing `--no-auto-maintain` / `autoMaintain`. These
 * tests pin that expression's behaviour directly against `parseArgs`, since exercising
 * `cmdWatch` itself needs a real git repo and an interactive TTY.
 */
describe("chong watch --no-auto-inject flag", () => {
  test("auto-inject defaults to enabled when the flag is omitted", () => {
    const { flags } = parseArgs(["/some/repo"]);
    expect(flags["no-auto-inject"] !== true).toBe(true);
  });

  test("--no-auto-inject disables auto-inject", () => {
    const { flags } = parseArgs(["/some/repo", "--no-auto-inject"]);
    expect(flags["no-auto-inject"] !== true).toBe(false);
  });

  test("is independent of --no-auto-maintain in both directions", () => {
    // The bug being fixed: --no-auto-maintain used to be the only opt-out anywhere near
    // this behaviour, and it did NOT disable auto-push. Confirm the two flags are
    // orthogonal now that --no-auto-inject exists.
    const onlyMaintainOff = parseArgs(["/some/repo", "--no-auto-maintain"]).flags;
    expect(onlyMaintainOff["no-auto-inject"] !== true).toBe(true); // auto-inject still on
    expect(onlyMaintainOff["no-auto-maintain"] !== true).toBe(false);

    const onlyInjectOff = parseArgs(["/some/repo", "--no-auto-inject"]).flags;
    expect(onlyInjectOff["no-auto-maintain"] !== true).toBe(true); // auto-maintain still on
    expect(onlyInjectOff["no-auto-inject"] !== true).toBe(false);

    const both = parseArgs(["/some/repo", "--no-auto-inject", "--no-auto-maintain"]).flags;
    expect(both["no-auto-inject"] !== true).toBe(false);
    expect(both["no-auto-maintain"] !== true).toBe(false);
  });
});
