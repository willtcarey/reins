import { test, expect } from "bun:test";
import { nodeMethods } from "./node-methods.js";
import { serverMethods } from "./server-methods.js";

test("the node serves its processes, files and Pi's commands: nothing of a session crosses the link (ADR-029, ADR-030)", () => {
  expect(Object.keys(nodeMethods)).toEqual(["process.run", "fs.info", "fs.list", "fs.read", "fs.write", "fs.absolutePath", "fs.canonicalPath", "stream.cancel", "node.reload", "pi.exec", "pi.execAttach", "pi.execKill"]);
  // The node calls nothing on the server: only its streams' frames go that way.
  expect(Object.keys(serverMethods)).toEqual(["stream.data", "stream.end"]);
});

test("a call works in the path the server sends, naming no source: the node has no sources (ADR-026)", () => {
  const calls = [
    [nodeMethods["process.run"].params, { streamId: "s1", argv: ["git", "status"] }],
    [nodeMethods["fs.info"].params, { path: "." }],
    [nodeMethods["fs.list"].params, { path: "." }],
    [nodeMethods["fs.read"].params, { streamId: "s1", path: "a.txt" }],
    [nodeMethods["fs.write"].params, { path: "a.txt", writeId: "w", offset: 0, data: "", last: true }],
    [nodeMethods["fs.absolutePath"].params, { path: "." }],
    [nodeMethods["fs.canonicalPath"].params, { path: "." }],
    [nodeMethods["pi.exec"].params, { streamId: "s1", execId: "e", command: "true", options: {} }],
  ] as const;
  for (const [params, input] of calls) {
    expect(params.safeParse({ cwd: "/src/app", ...input }).success).toBe(true);
    expect(params.safeParse({ sourceId: 7, cwd: "/src/app", ...input }).success).toBe(false);
    expect(params.safeParse(input).success).toBe(false);
    expect(params.safeParse({ cwd: "", ...input }).success).toBe(false);
  }
});
