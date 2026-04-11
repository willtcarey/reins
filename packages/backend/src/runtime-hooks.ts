import type { ServerState } from "./state.js";
import { subscribeAuthStorageChanges } from "./runtimes/pi/auth-storage.js";
import { reloadManagedSessionAuthStorage } from "./models/auth-credentials.js";
import { registerBuiltinRuntimeAdapters } from "./runtimes/register-builtins.js";

/**
 * Install auth-storage runtime hooks for a server instance.
 * Returns a cleanup function that removes the subscription.
 */
export function installRuntimeHooks(state: ServerState): () => void {
  registerBuiltinRuntimeAdapters();

  return subscribeAuthStorageChanges(() => {
    reloadManagedSessionAuthStorage(state.sessions);
  });
}
