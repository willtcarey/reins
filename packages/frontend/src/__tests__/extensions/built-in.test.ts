import { describe, expect, test } from "bun:test";
import type { BuiltInExtensionName } from "@backend/extensions/built-in-names.js";
import { BUILT_IN_EXTENSION_INFO } from "../../extensions/built-in.js";

/** Every built-in's name: typecheck fails when one is missing here or is not a built-in. */
const EVERY_BUILT_IN = {
  "mcp": true, "automations": true, "recent-sessions": true, "openai-images": true, "sidebar-projects": true,
  "file-viewer": true, "file-references": true, "compact-command": true, "new-session-command": true,
} satisfies Record<BuiltInExtensionName, true>;

describe("built-in extensions", () => {
  test("every one, whatever parts it has, has a label and a description for Settings", () => {
    const shown = BUILT_IN_EXTENSION_INFO.map(({ name, label, description }) => ({ name: String(name), label: Boolean(label), description: Boolean(description) }));

    expect(shown.toSorted((a, b) => a.name.localeCompare(b.name)))
      .toEqual(Object.keys(EVERY_BUILT_IN).toSorted().map(name => ({ name, label: true, description: true })));
  });
});
