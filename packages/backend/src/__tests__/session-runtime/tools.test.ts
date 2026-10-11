import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createHostTools } from "../../session-runtime/tools.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The session's node, as the tools reach it: here a local directory, recording the paths it was asked for. */
function nodeEnv(cwd: string): { env: ExecutionEnv; asked: string[] } {
  const local = new NodeExecutionEnv({ cwd });
  const asked: string[] = [];
  const env = new Proxy(local, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof args[0] === "string") asked.push(args[0]);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { env, asked };
}

test("the host tools are read, write, edit and bash; only read is safe to run again after an interruption", () => {
  const tools = createHostTools({ sessionId: "s", sessionEnvironment: { provider: "p", modelId: "m" }, serverAgentsDir: "/tmp/agents" });
  expect(tools.map(tool => [tool.name, tool.replay ?? "never"])).toEqual([["read", "safe"], ["write", "never"], ["edit", "never"], ["bash", "never"]]);
});

const invocation = { invocationId: "call", operationId: "operation", turnId: "turn", async getMemo() { return undefined; }, async setMemo() {} };

test("read serves paths under the server's own agent dir on the server (a stopgap), and every other path on the node", async () => {
  const agents = mkdtempSync(join(tmpdir(), "reins-agents-"));
  const checkout = mkdtempSync(join(tmpdir(), "reins-checkout-"));
  dirs.push(agents, checkout);
  mkdirSync(join(agents, "skills/server-skill"), { recursive: true });
  writeFileSync(join(agents, "skills/server-skill/SKILL.md"), "On the server");
  writeFileSync(join(checkout, "notes.md"), "On the node");
  const read = createHostTools({ sessionId: "s", sessionEnvironment: { provider: "p", modelId: "m" }, serverAgentsDir: agents }).find(tool => tool.name === "read")!;
  const node = nodeEnv(checkout);
  const text = async (path: string) => {
    const { content } = await read.execute("call", { path }, () => undefined, { env: node.env }, invocation, BACKGROUND_CONTEXT);
    return content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
  };

  expect(await text(join(agents, "skills/server-skill/SKILL.md"))).toBe("On the server");
  expect(node.asked).toEqual([]);
  expect(await text("notes.md")).toBe("On the node");
  expect(node.asked).toContain(join(checkout, "notes.md"));
});
