import { describe, expect, test } from "bun:test";
import { statusDot } from "../../ui/status-dot.js";
import { templateToString } from "../helpers/lit-template.js";

describe("statusDot", () => {
  test("a labelled dot is named for assistive technology and its tooltip", () => {
    const output = templateToString(statusDot("success", { label: "Connected" }));

    expect(output).toContain('role="img"');
    expect(output).toContain('aria-label="Connected"');
    expect(output).toContain('title="Connected"');
  });

  test("a dot without a label is hidden from assistive technology, as the text beside it says its status", () => {
    const output = templateToString(statusDot("danger"));

    expect(output).toContain('aria-hidden="true"');
    expect(output).not.toContain("aria-label");
  });
});
