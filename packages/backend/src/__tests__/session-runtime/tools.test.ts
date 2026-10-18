import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT, ExecutionError,
  type AgentHarnessToolInvocation, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult, type ShellOutputTruncation,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createHostTools } from "../../session-runtime/tools.js";
import type { CommandCall } from "../../sessions/remote-env.js";

/** A value a tool call's memo holds. */
type JsonValue = Parameters<AgentHarnessToolInvocation["setMemo"]>[1];
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

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

test("the host tools are read, write, edit and bash; read and bash are safe to run again after an interruption", () => {
  const tools = createHostTools({ sessionId: "s", sessionEnvironment: { provider: "p", modelId: "m" } });
  expect(tools.map(tool => [tool.name, tool.replay ?? "never"])).toEqual([["read", "safe"], ["write", "never"], ["edit", "never"], ["bash", "safe"]]);
});

/** A tool call's durable memos, as Pi keeps them until its outcome is committed; `log` records each write. */
function invocationWith(memos: Record<string, JsonValue>, log: string[]): AgentHarnessToolInvocation {
  return {
    invocationId: "call", operationId: "operation", turnId: "turn",
    async getMemo(name) { return memos[name]; },
    async setMemo(name, value) { log.push(`memo ${name}`); if (value === undefined) delete memos[name]; else memos[name] = value; },
  };
}

/** The session's node as bash reaches it: its commands under the call's ID (`execCommand`), each logged
 * with whether it was sent or picked up (and kept in `calls`), and answered by `answer`. */
function commandHost(log: string[], answer: (options: ShellExecOptions | undefined) => Promise<Result<ShellExecResult, ExecutionError>>, calls: CommandCall[] = []) {
  return Object.assign(new NodeExecutionEnv({ cwd: "/checkout" }), {
    exec: () => { throw new Error("bash runs its command under the call's ID"); },
    async execCommand(call: CommandCall, _command: string, options: ShellExecOptions | undefined) {
      calls.push(call);
      log.push(`${call.attach ? "attach" : "send"} ${call.execId}`);
      return answer(options);
    },
  });
}
const exited = (exitCode: number): Result<ShellExecResult, ExecutionError> => ({ ok: true, value: { exitCode, truncation: noTruncation } });
const noTruncation: ShellOutputTruncation = { truncated: false, truncatedBy: null, totalLines: 0, totalBytes: 0, outputLines: 0, outputBytes: 0, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 2000, maxBytes: 51_200 };
const bash = () => createHostTools({ sessionId: "s", sessionEnvironment: { provider: "p", modelId: "m" } }).find(tool => tool.name === "bash")!;
/** What a bash call comes to: its text, or the message of the error it throws. */
async function runBash(env: ExecutionEnv, invocationValue: AgentHarnessToolInvocation): Promise<{ text?: string; error?: string }> {
  try {
    const { content } = await bash().execute("call", { command: "make" }, () => undefined, { env }, invocationValue, BACKGROUND_CONTEXT);
    return { text: content.flatMap(block => block.type === "text" ? [block.text] : []).join("") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
const INTERRUPTED = "[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

test("bash records its command's ID with the call before it sends the command, and keeps the output it checkpoints", async () => {
  const log: string[] = [];
  const memos: Record<string, JsonValue> = {};
  const calls: CommandCall[] = [];
  const env = commandHost(log, async options => {
    options?.onUpdate?.({ kind: "append", text: "started\n", metadata: { truncation: noTruncation } }, BACKGROUND_CONTEXT);
    // Pi's bash checkpoints its output at most every 2 s.
    setSystemTime(new Date(Date.now() + 3_000));
    options?.onUpdate?.({ kind: "append", text: "done\n", metadata: { truncation: noTruncation } }, BACKGROUND_CONTEXT);
    return exited(0);
  }, calls);
  try {
    expect(await runBash(env, invocationWith(memos, log))).toEqual({ text: "started\ndone\n" });
  } finally { setSystemTime(); }
  await until(() => log.length === 3);
  expect(calls).toEqual([{ execId: expect.any(String), attach: false }]);
  expect(memos.exec).toEqual({ execId: calls[0]!.execId });
  expect(log).toEqual(["memo exec", `send ${calls[0]!.execId}`, "memo output"]);
  expect(memos.output).toEqual({ text: "started\ndone\n" });
});

test("bash run again with its command's ID recorded (Pi reruns it after the server restarted) only picks the command up again, and gets its result", async () => {
  const log: string[] = [];
  const env = commandHost(log, async options => {
    options?.onUpdate?.({ kind: "replace", output: { text: "started\ndone\n", truncation: noTruncation } }, BACKGROUND_CONTEXT);
    return exited(0);
  });
  expect(await runBash(env, invocationWith({ exec: { execId: "recorded" }, output: { text: "started\n" } }, log))).toEqual({ text: "started\ndone\n" });
  expect(log).toEqual(["attach recorded"]);
});

test("bash run again whose command the node no longer has comes back with the last output it saved and Pi's interruption text, as a call Pi cannot rerun does", async () => {
  const log: string[] = [];
  const lost = commandHost(log, async () => ({ ok: false, error: new ExecutionError("unknown", "The command's outcome is unknown: the node does not have it") }));
  expect(await runBash(lost, invocationWith({ exec: { execId: "recorded" }, output: { text: "started\n" } }, log))).toEqual({ error: `started\n\n\n${INTERRUPTED}` });
  expect(await runBash(lost, invocationWith({ exec: { execId: "recorded" } }, log))).toEqual({ error: INTERRUPTED });
  expect(log).toEqual(["attach recorded", "attach recorded"]);
  // An environment that cannot pick a command up by its ID never runs it again.
  const local = nodeEnv(mkdtempSync(join(tmpdir(), "reins-checkout-")));
  dirs.push(local.env.cwd);
  expect(await runBash(local.env, invocationWith({ exec: { execId: "recorded" }, output: { text: "started\n" } }, log))).toEqual({ error: `started\n\n\n${INTERRUPTED}` });
  expect(local.asked).toEqual([]);
});
