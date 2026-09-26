import type { ServerState } from "./state.js";
import { registerBuiltinRuntimeAdapters } from "./runtimes/register-builtins.js";
import { subscribeInternalNodeServices } from "./runtimes/internal-node.js";
import { nodeSessionReports } from "./runtimes/node-session-events.js";
import { nodeToolCalls } from "./runtimes/node-tool-calls.js";
import { registerExecutionTargets } from "./runtimes/execution-target.js";
import { internalNodeExecutionTarget } from "./runtimes/internal-node-execution.js";
import { legacyExecutionTarget } from "./runtimes/legacy-session-execution.js";

/** Install process-level runtime registrations for a server instance. */
export function installRuntimeHooks(state: ServerState): () => void {
  registerBuiltinRuntimeAdapters();
  const unregisterTargets = registerExecutionTargets(state, {
    "internal-node": internalNodeExecutionTarget(state),
    server: legacyExecutionTarget(state),
  });
  const unsubscribe = subscribeInternalNodeServices(state, { ...nodeSessionReports(state), ...nodeToolCalls(state) });
  return () => { unsubscribe(); unregisterTargets(); };
}
