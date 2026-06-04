/**
 * Pi SDK Test Helpers
 *
 * Helpers for testing code that depends on the pi coding agent SDK.
 * Creates real AgentSessions, ManagedSessions, and strict ExtensionContext
 * stubs — all backed by in-memory storage with no network calls.
 */

import {
  type AgentSession,
  type ExtensionContext,
  createAgentSession,
  AuthStorage,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { ManagedSession } from "../../state.js";
import { PiAgentRuntime } from "../../runtimes/pi/runtime.js";

const defaultModel = getModel("anthropic", "claude-sonnet-4-20250514");

/**
 * Create a real AgentSession with in-memory storage.
 * No filesystem access, no network calls, no API key required.
 */
export async function createTestAgentSession(): Promise<AgentSession> {
  const authStorage = AuthStorage.inMemory({
    anthropic: { type: "api_key", key: "fake-key-for-testing" },
  });

  const { session } = await createAgentSession({
    authStorage,
    model: defaultModel,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    tools: [],
    cwd: "/tmp",
  });

  return session;
}

export interface TestManagedSessionOverrides {
  isStreaming?: boolean;
}

/**
 * Create a ManagedSession wrapping a real AgentSession.
 *
 * Accepts optional property overrides for values that can't be set through
 * the normal API (e.g. isStreaming, which is normally driven by agent state).
 */
export async function createTestManagedSession(
  id: string,
  overrides?: TestManagedSessionOverrides,
): Promise<ManagedSession> {
  const session = await createTestAgentSession();

  if (overrides?.isStreaming !== undefined) {
    Object.defineProperty(session, "isStreaming", {
      get: () => overrides.isStreaming,
      configurable: true,
    });
  }

  return {
    runtime: new PiAgentRuntime(session, id),
    id,
    lastActivity: Date.now(),
  };
}

/**
 * Create a strict ExtensionContext stub that throws on any property access.
 *
 * The pi SDK requires `ctx` in `ToolDefinition.execute()`, but our tools may
 * not use it. If a tool starts accessing ctx, this proxy fails loudly with a
 * message naming the exact property — so you know what to wire up.
 */
export function createStrictExtensionContext(): ExtensionContext {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      throw new Error(`ExtensionContext.${String(prop)} was accessed but not provided in test stub`);
    },
  });
}
