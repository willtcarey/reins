import { PiRuntimeAdapter } from "./pi/session.js";
import { ClaudeSdkRuntimeAdapter } from "./claude_agent_sdk/adapter.js";
import { registerRuntimeAdapter } from "./registry.js";

/**
 * Register runtime adapters bundled with the backend.
 * Safe to call repeatedly (Map#set overwrites by runtimeType).
 */
export function registerBuiltinRuntimeAdapters(): void {
  registerRuntimeAdapter(new PiRuntimeAdapter());
  registerRuntimeAdapter(new ClaudeSdkRuntimeAdapter());
}
