import { test, expect } from "bun:test";
import { capability } from "./node-methods.js";
import { serverMethods } from "./server-methods.js";

test("the node's capabilities are its tool and file host's methods: nothing of a session crosses the link (ADR-029)", () => {
  for (const method of ["process.run", "fs.list", "fs.read", "fs.write", "stream.cancel", "node.reload", "env.fs", "env.exec", "env.execAttach", "env.execKill", "checkout.environment"]) {
    expect(capability.safeParse(method).success).toBe(true);
  }
  for (const method of ["session.prompt", "session.abort", "skills.list", "credentials.changed"]) expect(capability.safeParse(method).success).toBe(false);
  // The node calls nothing on the server: only its streams' frames go that way.
  expect(Object.keys(serverMethods)).toEqual(["stream.data", "stream.end"]);
});
