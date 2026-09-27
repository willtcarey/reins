import type { CredentialStore } from "@earendil-works/pi-ai";
import { APPLICATION_ERROR, RpcFailure, toNodeCredential, type CredentialInfo, type NodeCredential } from "@reins/node/protocol";
import { createDbCredentialStore } from "./pi/credential-store.js";
import { createPiModelRuntime } from "./pi/factory.js";
import { logger } from "../logger.js";

/** Resolves request auth for one provider through Pi (`ModelRuntime.getAuth`), which refreshes an
 * expiring OAuth login under the credential store's per-provider lock. */
export type ResolveProviderAuth = (providerId: string) => Promise<unknown>;

export interface NodeCredentialService {
  readCredential(providerId: string): Promise<NodeCredential | null>;
  refreshCredential(providerId: string): Promise<NodeCredential | null>;
  listCredentials(): Promise<CredentialInfo[]>;
}

const failure = (code: "unavailable" | "invalid_request", message: string, retryable: boolean) =>
  new RpcFailure(APPLICATION_ERROR, message, undefined, { code, message, retryable });

/**
 * The server is the sole credential holder and the sole OAuth refresher for nodes. A refresh runs
 * Pi's own resolution (`resolveStoredOAuth`) against the server's `DbCredentialStore`: under the
 * store's per-provider serialization it re-checks expiry, refreshes only if the stored token is still
 * inside Pi's refresh window, and persists the rotated credential before releasing the lock. Legacy
 * server-owned sessions resolve through the same store and lock, so exactly one refresh of a login
 * happens however many node requests and server sessions ask at once. Values never reach logs or
 * error messages; results never carry the refresh token (`toNodeCredential`).
 */
export function createNodeCredentialService(
  store: CredentialStore = createDbCredentialStore(),
  resolve: ResolveProviderAuth = async providerId => (await createPiModelRuntime()).getAuth(providerId),
): NodeCredentialService {
  return {
    async readCredential(providerId) { return toNodeCredential(await store.read(providerId)); },
    async refreshCredential(providerId) {
      const stored = await store.read(providerId);
      if (stored?.type !== "oauth") return toNodeCredential(stored);
      let auth: unknown;
      try { auth = await resolve(providerId); }
      catch (error) {
        // Pi's message names the provider and the provider's reason; it carries no token.
        logger.error(`OAuth refresh for node failed (${providerId}):`, error instanceof Error ? error.message : String(error));
        throw failure("unavailable", `OAuth refresh failed for ${providerId}; sign in again on the server if this persists`, true);
      }
      const current = await store.read(providerId);
      // Logged out meanwhile: the node sees no credential, as for any logged-out provider.
      if (!current) return null;
      if (auth === undefined && current.type === "oauth") throw failure("invalid_request", `No OAuth provider for ${providerId} on the server`, false);
      return toNodeCredential(current);
    },
    async listCredentials() {
      return (await store.list()).map(({ providerId, type }) => ({ providerId, type }));
    },
  };
}
