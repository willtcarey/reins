import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  type AgentHarnessTool, type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

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

/**
 * Pi's native tools (read, write, edit, bash) on the session's execution environment, which runs them on
 * its node (`RemoteExecutionEnv`), except `read` of the server's own agent dir (`serverAgentsDir`, see
 * `readingServerDir`). Only `read` is safe to run again: Pi reruns a call an interruption cut off when the
 * tool says so, and tells the model "outcome unknown" otherwise. bash's environment carries the session's
 * live model selection on each call.
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
    createBashTool<HostToolContext>({
      prepare: execution => {
        execution.env.PI_SESSION_ID = params.sessionId;
        execution.env.PI_PROVIDER = params.sessionEnvironment.provider;
        execution.env.PI_MODEL = params.sessionEnvironment.modelId;
        if (params.sessionEnvironment.thinkingLevel) execution.env.PI_REASONING_LEVEL = params.sessionEnvironment.thinkingLevel;
        else delete execution.env.PI_REASONING_LEVEL;
      },
    }),
  ];
}
