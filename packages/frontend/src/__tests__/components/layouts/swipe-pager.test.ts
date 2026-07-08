import { describe, expect, test } from "bun:test";
import { SwipePager } from "../../../components/layouts/swipe-pager.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("SwipePager", () => {
  test("renders each provided page in order", () => {
    const pager = new SwipePager();
    pager.pages = ["one", "two", "three", "four", "five", "six"];

    const output = templateToString(pager.render());

    expect(output).toContain("swipe-pager-shell");
    expect(output).toContain("swipe-pager-strip");
    expect(output).not.toContain("mobile-layout");
    expect(output.match(/<section/g)?.length).toBe(6);
    expect(output.indexOf("one")).toBeLessThan(output.indexOf("six"));
  });

});
