import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  type AgentHarnessTool, type AgentToolResult, type ExecutionEnv, type ExecutionError, type Result, type ShellExecResult,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { z } from "zod";
import type { CommandCall, RemoteExecutionEnv } from "../sessions/remote-env.js";

export interface HostToolContext { env: ExecutionEnv }

/** The file operations `read` uses whose first argument is a path. */
const PATH_OPS: ReadonlySet<PropertyKey> = new Set(["absolutePath", "canonicalPath", "exists", "fileInfo", "readTextFile", "readBinaryFile"]);

/**
 * `env`, except that reads of paths under `dir` on the server's machine are served there: the server's own
 * `~/.agents`, whose skills the session's environment lists by their paths here (ADR-029, a stopgap to
 * revisit: the model reads a skill with `read`, which otherwise runs on the session's node).
 */
function readingServerDir(env: ExecutionEnv, dir: string): ExecutionEnv {
  const local = new NodeExecutionEnv({ cwd: dir });
  const here = (path: unknown) => typeof path === "string" && (path === dir || path.startsWith(`${dir}/`));
  return new Proxy(env, {
    get(target, property) {
      if (PATH_OPS.has(property)) {
        return (path: unknown, ...rest: unknown[]) => Reflect.apply(Reflect.get(here(path) ? local : target, property), here(path) ? local : target, [path, ...rest]);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** An environment that runs a command under the ID its tool call recorded (`RemoteExecutionEnv`). */
type CommandHost = ExecutionEnv & Pick<RemoteExecutionEnv, "execCommand">;
const isCommandHost = (env: ExecutionEnv): env is CommandHost => "execCommand" in env && typeof env.execCommand === "function";

/** `env`, except that its commands run under `call` (`execCommand`), each result shown to `observe`. */
function commandsUnder(env: CommandHost, call: CommandCall, observe: (result: Result<ShellExecResult, ExecutionError>) => void): ExecutionEnv {
  return new Proxy(env, {
    get(target, property) {
      if (property === "exec") {
        return async (...[command, options, context]: Parameters<ExecutionEnv["exec"]>) => {
          const result = await target.execCommand(call, command, options, context);
          observe(result);
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Pi 0.85.1's text for a tool call an interruption cut off that it does not run again (not exported). */
const INTERRUPTED = "[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";
/** A bash call's memos: its command's ID, recorded before the command is sent, and its latest checkpointed output. */
const execMemo = z.object({ execId: z.string() });
const outputMemo = z.object({ text: z.string() });
const textOf = (result: AgentToolResult<unknown>) => result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");

/**
 * bash, safe to run again after the server restarted mid-call: Pi then reruns the call with the same
 * invocation, whose memos it keeps until the call's outcome is committed. The command runs under an ID
 * recorded with the call (memo `exec`) before anything is sent, so a rerun only picks that command up again
 * on the node (`execCommand` with `attach`) and never sends it twice. A rerun whose command the node does
 * not have (it restarted, the server was away past its grace period, or the server stopped between
 * recording the ID and sending the command), or that has no environment to pick it up from, gives what Pi
 * gives a call it cannot rerun: the last saved output and its interruption text. Pi deletes its own
 * checkpoint before a rerun, so the call keeps its latest checkpointed output too (memo `output`).
 */
function reattachingBash(bash: AgentHarnessTool<HostToolContext>): AgentHarnessTool<HostToolContext> {
  return {
    ...bash, replay: "safe",
    async execute(toolCallId, args, onUpdate, toolContext, invocation, context) {
      const recorded = execMemo.safeParse(await invocation.getMemo("exec")).data;
      let latest = recorded ? outputMemo.safeParse(await invocation.getMemo("output")).data?.text : undefined;
      const interrupted = () => new Error(latest ? `${latest}\n\n${INTERRUPTED}` : INTERRUPTED);
      const { env } = toolContext;
      if (recorded && !isCommandHost(env)) throw interrupted();
      const call = { execId: recorded?.execId ?? crypto.randomUUID(), attach: recorded !== undefined };
      if (!recorded) await invocation.setMemo("exec", { execId: call.execId });
      const update: typeof onUpdate = (partial, options) => {
        if (partial.content.length > 0) latest = textOf(partial);
        // The call may have ended meanwhile (its memos are gone with it).
        if (options?.checkpoint) void invocation.setMemo("output", { text: textOf(partial) }).catch(() => undefined);
        onUpdate(partial, options);
      };
      if (!isCommandHost(env)) return bash.execute(toolCallId, args, update, toolContext, invocation, context);
      let lost = false;
      const callEnv = commandsUnder(env, call, result => { lost = call.attach && !result.ok && result.error.code === "unknown"; });
      try {
        return await bash.execute(toolCallId, args, update, { env: callEnv }, invocation, context);
      } catch (error) {
        if (lost) throw interrupted();
        throw error;
      }
    },
  };
}

/**
 * Pi's native tools (read, write, edit, bash) on the session's execution environment, which runs them on
 * its node (`RemoteExecutionEnv`), except `read` of the server's own agent dir (`serverAgentsDir`, see
 * `readingServerDir`). `read` and bash are safe to run again: Pi reruns a call an interruption cut off when
 * the tool says so (read reads again; bash picks its command up again, `reattachingBash`), and tells the
 * model "outcome unknown" otherwise. bash's environment carries the session's live model selection on
 * each call.
 */
export function createHostTools(params: {
  sessionId: string;
  sessionEnvironment: { provider: string; modelId: string; thinkingLevel?: string | null };
  serverAgentsDir: string;
}): AgentHarnessTool<HostToolContext>[] {
  const read = createReadTool<HostToolContext>();
  const readHere: typeof read = {
    ...read, replay: "safe",
    execute: (toolCallId, args, onUpdate, toolContext, invocation, context) =>
      read.execute(toolCallId, args, onUpdate, { env: readingServerDir(toolContext.env, params.serverAgentsDir) }, invocation, context),
  };
  return [
    readHere,
    createWriteTool<HostToolContext>(),
    createEditTool<HostToolContext>(),
    reattachingBash(createBashTool<HostToolContext>({
      prepare: execution => {
        execution.env.PI_SESSION_ID = params.sessionId;
        execution.env.PI_PROVIDER = params.sessionEnvironment.provider;
        execution.env.PI_MODEL = params.sessionEnvironment.modelId;
        if (params.sessionEnvironment.thinkingLevel) execution.env.PI_REASONING_LEVEL = params.sessionEnvironment.thinkingLevel;
        else delete execution.env.PI_REASONING_LEVEL;
      },
    })),
  ];
}
