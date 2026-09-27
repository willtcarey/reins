/**
 * Pi SDK Test Helpers
 *
 * Helpers for testing code that depends on the pi coding agent SDK.
 * Creates real AgentSessions and strict ExtensionContext
 * stubs — all backed by in-memory storage with no network calls.
 */

import {
  type AgentSession,
  type ExtensionContext,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

const defaultModel = getModel("anthropic", "claude-sonnet-4-5");

/**
 * Create a real AgentSession with in-memory storage.
 * No filesystem access, no network calls, no API key required.
 */
export async function createTestAgentSession(options: { sessionManager?: SessionManager } = {}): Promise<AgentSession> {
  const credentials = new Map<string, Credential>([
    ["anthropic", { type: "api_key", key: "fake-key-for-testing" }],
  ]);
  const credentialStore: CredentialStore = {
    read: async (providerId) => credentials.get(providerId),
    list: async () => [...credentials].map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: async (providerId, fn) => {
      const next = await fn(credentials.get(providerId));
      if (next) credentials.set(providerId, next);
      return next;
    },
    delete: async (providerId) => { credentials.delete(providerId); },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    refreshOnCreate: false,
  });

  const { session } = await createAgentSession({
    modelRuntime,
    model: defaultModel,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    tools: [],
    cwd: "/tmp",
  });

  return session;
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
