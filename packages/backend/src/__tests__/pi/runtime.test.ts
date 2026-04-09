import { describe, test, expect } from "bun:test";
import { createPiRuntimeForCwd } from "../../pi/runtime.js";

describe("pi runtime", () => {
  test("builds a cwd-scoped runtime with extension-registered providers", async () => {
    const runtime = await createPiRuntimeForCwd({
      cwd: "/tmp/reins-pi-runtime",
    });

    expect(runtime.extensionErrors).toEqual([]);
    expect(runtime.providerRegistrations.some((registration) => registration.name === "claude-agent-sdk")).toBe(true);
    expect(runtime.modelRegistry.find("claude-agent-sdk", "claude-opus-4-5")).toBeDefined();
  });
});
