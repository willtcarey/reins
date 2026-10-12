import { test, expect } from "bun:test";
import { capability } from "./node-methods.js";
import { serverMethods } from "./server-methods.js";

test("the node's capabilities are its processes, files and Pi's commands: nothing of a session crosses the link (ADR-029, ADR-030)", () => {
  for (const method of ["process.run", "fs.info", "fs.list", "fs.read", "fs.write", "fs.absolutePath", "fs.canonicalPath", "stream.cancel", "node.reload", "pi.exec", "pi.execAttach", "pi.execKill"]) {
    expect(capability.safeParse(method).success).toBe(true);
  }
  for (const method of ["session.prompt", "skills.list", "env.fs", "env.exec", "checkout.environment"]) expect(capability.safeParse(method).success).toBe(false);
  // The node calls nothing on the server: only its streams' frames go that way.
  expect(Object.keys(serverMethods)).toEqual(["stream.data", "stream.end"]);
});
