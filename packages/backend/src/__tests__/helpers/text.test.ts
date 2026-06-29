import { describe, expect, test } from "bun:test";
import { dedent } from "./text.js";

describe("dedent", () => {
  test("strips common indentation and preserves the trailing newline", () => {
    expect(dedent`
      first
        second
      third
    `).toBe("first\n  second\nthird\n");
  });

  test("supports interpolated values", () => {
    const value = "world";

    expect(dedent`
      hello ${value}
    `).toBe("hello world\n");
  });
});
