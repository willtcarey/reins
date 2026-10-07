import { expect, test } from "bun:test";
import { createHostTools } from "./tools.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";

test("host tools are constructed with node cwd; only read is safe to run again after an interruption", async () => {
  const host = createHostTools({
    cwd: "/tmp/reins-node-tools", sessionId: "node-tool-session",
    sessionEnvironment: { provider: "test", modelId: "fake", thinkingLevel: "low" },
  });
  try {
    expect(host.tools.map(tool => [tool.name, tool.replay ?? "never"])).toEqual([["read", "safe"], ["write", "never"], ["edit", "never"], ["bash", "never"]]);
    expect(host.executionEnv.cwd).toBe("/tmp/reins-node-tools");
  } finally { await host.executionEnv.cleanup(BACKGROUND_CONTEXT); }
});
