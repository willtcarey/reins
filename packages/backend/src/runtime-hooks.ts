import type { ServerState } from "./state.js";
import { subscribeAuthStorageChanges } from "./auth-storage.js";

function reloadSessionAuthStorage(state: ServerState): void {
  for (const managed of state.sessions.values()) {
    managed.session.modelRegistry.authStorage.reload();
  }
}

/**
 * Install auth-storage runtime hooks for a server instance.
 * Returns a cleanup function that removes the subscription.
 */
export function installRuntimeHooks(state: ServerState): () => void {
  return subscribeAuthStorageChanges(() => {
    reloadSessionAuthStorage(state);
  });
}
