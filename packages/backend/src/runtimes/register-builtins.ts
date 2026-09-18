import { AgentHarnessPiRuntimeAdapter } from "./pi/agent-harness-adapter.js";
import { registerRuntimeAdapter } from "./registry.js";

/**
 * Register runtime adapters bundled with the backend.
 * Safe to call repeatedly (Map#set overwrites by runtimeType).
 */
export function registerBuiltinRuntimeAdapters(): void {
  registerRuntimeAdapter(new AgentHarnessPiRuntimeAdapter());
}
