import { test, expect } from "bun:test";
import { nodeMethods } from "./node-methods.js";
import { serverMethods } from "./server-methods.js";

test("the node serves its processes, files and Pi's commands: nothing of a session crosses the link (ADR-029)", () => {
  expect(Object.keys(nodeMethods)).toEqual(["process.start", "process.attach", "process.write", "process.stop", "fs.info", "fs.list", "fs.read", "fs.write", "fs.absolutePath", "fs.canonicalPath", "stream.cancel", "node.reload", "pi.exec", "pi.execAttach", "pi.execKill"]);
  // The node calls nothing on the server: only its streams' frames go that way.
  expect(Object.keys(serverMethods)).toEqual(["stream.data", "stream.end"]);
});

test("a call works in the path the server sends, naming no source: the node has no sources (ADR-026)", () => {
  const calls = [
    [nodeMethods["process.start"].params, { streamId: "s1", processId: "p", argv: ["git", "status"] }],
    [nodeMethods["process.start"].params, { streamId: "s1", processId: "p", command: "npx -y server", stdin: false }],
    [nodeMethods["fs.info"].params, { path: "." }],
    [nodeMethods["fs.list"].params, { path: "." }],
    [nodeMethods["fs.read"].params, { streamId: "s1", path: "a.txt" }],
    [nodeMethods["fs.read"].params, { streamId: "s1", path: "a.txt", offset: 8, maxBytes: 4 }],
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

test("a process is started from argv or a shell command, never both or neither", () => {
  const start = nodeMethods["process.start"].params;
  const base = { cwd: "/src/app", streamId: "s1", processId: "p" };
  expect(start.safeParse({ ...base, argv: ["cat"], command: "cat" }).success).toBe(false);
  expect(start.safeParse(base).success).toBe(false);
  expect(start.safeParse({ ...base, argv: [""] }).success).toBe(false);
});

test("a write to a process's stdin says where its bytes go, so one sent again is recognised; an attach says where to read from", () => {
  expect(nodeMethods["process.write"].params.safeParse({ processId: "p", offset: 0, data: "eA==" }).success).toBe(true);
  expect(nodeMethods["process.write"].params.safeParse({ processId: "p", data: "eA==" }).success).toBe(false);
  expect(nodeMethods["process.attach"].params.safeParse({ streamId: "s2", processId: "p", offset: 1024 }).success).toBe(true);
  expect(nodeMethods["process.attach"].params.safeParse({ streamId: "s2", processId: "p" }).success).toBe(false);
});
