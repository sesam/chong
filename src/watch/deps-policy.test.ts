import { describe, expect, test } from "bun:test";
import { parseTarget } from "./deps-policy";

describe("parseTarget", () => {
  test("scoped package", () => {
    expect(parseTarget("@eslint/js@9.39.4")).toEqual({ name: "@eslint/js", version: "9.39.4" });
  });

  test("unscoped package", () => {
    expect(parseTarget("lodash@4.18.1")).toEqual({ name: "lodash", version: "4.18.1" });
  });

  test("invalid", () => {
    expect(parseTarget("nover")).toBeNull();
  });
});
