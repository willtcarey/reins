import { describe, test, expect } from "bun:test";
import { createPiContext } from "../../../runtimes/pi/factory.js";

describe("pi runtime", () => {
  test("builds a cwd-scoped runtime with built-in providers", async () => {
    const runtime = await createPiContext({
      cwd: "/tmp/reins-pi-runtime",
    });

    expect(runtime.modelRegistry.getAll().length).toBeGreaterThan(0);
    expect(runtime.modelRegistry.find("anthropic", "claude-sonnet-4-20250514")).toBeDefined();
  });
});
