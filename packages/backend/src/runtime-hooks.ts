import type { ServerState } from "./state.js";
import { registerBuiltinRuntimeAdapters } from "./runtimes/register-builtins.js";

/** Install process-level runtime registrations for a server instance. */
export function installRuntimeHooks(_state: ServerState): () => void {
  registerBuiltinRuntimeAdapters();
  return () => {};
}
