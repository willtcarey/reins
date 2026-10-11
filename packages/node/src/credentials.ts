import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { NodeCredential } from "@reins/node-protocol";

/** The node's view of the server's credential service (`credentials.*` over the attached connection). */
export interface CredentialServer {
  getCredential(providerId: string, signal?: AbortSignal): Promise<NodeCredential | null>;
  refreshCredential(providerId: string, signal?: AbortSignal): Promise<NodeCredential | null>;
  listCredentials(signal?: AbortSignal): Promise<CredentialInfo[]>;
}

/** Mirrors pi-ai's `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS` (not exported; `auth/resolve.ts`): Pi refreshes
 * an OAuth token with less than this validity left in `resolveStoredOAuth`, so such a token is not
 * served from the cache. Keep in step with pi-ai. */
export const OAUTH_MIN_VALIDITY_MS = 5 * 60_000;
export const NO_SERVER_MESSAGE = "Credentials unavailable: no Reins server connection";
const MANAGED_BY_SERVER = "Credentials are managed by the Reins server";

interface RemoteCredentialStore extends CredentialStore {
  /** Drops what is cached for `providerId` (the server said it changed) and the list, or everything (a
   * connection attached, so a reconnect re-reads). A call already in flight for it is neither cached
   * nor joined. */
  invalidate(providerId?: string): void;
}

/**
 * Pi's `CredentialStore` over the server connection. The server is the sole credential holder and
 * the sole OAuth refresher: an OAuth credential here has no refresh token (`refresh` is empty), so
 * `modify` never runs Pi's refresh on the node; it asks the server with `credentials.refresh`.
 * Answers are cached in memory only (never on disk): per provider its credential or that it is logged
 * out (Pi checks every registered provider, several times, on every model runtime it builds), and the
 * list. An entry lasts until it is no longer usable as-is (an OAuth token entering Pi's refresh window)
 * or until `invalidate()`; there is no TTL: a server-side login, logout or key change reaches a connected
 * node through `credentials.changed` (best effort), and any node on its next attach. The cache survives
 * a detach: a cached answer keeps serving while no connection is attached.
 */
export function createRemoteCredentialStore(server: () => CredentialServer | undefined, now: () => number = Date.now): RemoteCredentialStore {
  // Every invalidation bumps `generation`; a call's result is cached only if neither the whole cache
  // nor its provider (for the list: any provider) was invalidated after it started.
  let generation = 0;
  let clearedAt = 0;
  let changedAt = 0;
  const invalidatedAt = new Map<string, number>();
  /** A provider's cached answer: its credential, or undefined when it is logged out. */
  const cache = new Map<string, { credential: Credential | undefined }>();
  let listed: readonly CredentialInfo[] | undefined;
  const reads = new Map<string, Promise<Credential | undefined>>();
  const refreshes = new Map<string, Promise<Credential | undefined>>();
  const lists = new Map<string, Promise<readonly CredentialInfo[]>>();
  const fresh = (providerId: string) => {
    const cached = cache.get(providerId);
    const credential = cached?.credential;
    if (credential?.type === "oauth" && now() + OAUTH_MIN_VALIDITY_MS >= credential.expires) { cache.delete(providerId); return undefined; }
    return cached;
  };
  const connection = () => {
    const current = server();
    if (!current) throw new Error(NO_SERVER_MESSAGE);
    return current;
  };
  /** One call per key at a time: concurrent callers join it. Not cancelled by one caller's signal (Pi
   * races its own signal against the whole resolution). `call` gets the generation it started in. */
  const shared = <T>(inflight: Map<string, Promise<T>>, key: string, call: (started: number) => Promise<T>) => {
    const pending = inflight.get(key);
    if (pending) return pending;
    const request = call(generation);
    inflight.set(key, request);
    void request.finally(() => { if (inflight.get(key) === request) inflight.delete(key); }).catch(() => undefined);
    return request;
  };
  const credentialCall = (inflight: Map<string, Promise<Credential | undefined>>, providerId: string, call: (server: CredentialServer) => Promise<NodeCredential | null>) =>
    shared(inflight, providerId, async started => {
      const credential = fromWire(await call(connection()));
      // A result that raced an invalidation may be stale (a previous connection, a changed credential): not cached.
      if (started >= clearedAt && started >= (invalidatedAt.get(providerId) ?? 0)) cache.set(providerId, { credential });
      return credential;
    });
  return {
    async read(providerId: string, options?: AuthOperationOptions) {
      options?.signal?.throwIfAborted();
      const cached = fresh(providerId);
      return cached ? cached.credential : credentialCall(reads, providerId, current => current.getCredential(providerId));
    },
    async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      options?.signal?.throwIfAborted();
      return listed ?? shared(lists, "", async started => {
        const credentials = await connection().listCredentials();
        if (started >= changedAt) listed = credentials;
        return credentials;
      });
    },
    /**
     * Pi calls `modify` to refresh an expiring OAuth login (`resolveStoredOAuth`, and the model catalog's
     * `resolveRefreshCredential`) and to persist a login (`Models.login`). Every Pi refresh function
     * returns undefined without side effects when the stored credential is not OAuth, so `fn` is probed
     * with no credential: a function that still writes one is a login, which only the server performs.
     * Otherwise `fn` is not run again: the server refreshes (once, under its own lock) and its current
     * credential is returned, which is all Pi reads from `modify` on the refresh path.
     */
    async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
      options?.signal?.throwIfAborted();
      if (await fn(undefined) !== undefined) throw new Error(`${MANAGED_BY_SERVER}: sign in on the server`);
      // Refreshed meanwhile (by a concurrent request on this node): nothing to ask.
      const cached = fresh(providerId)?.credential;
      if (cached?.type === "oauth") return cached;
      return credentialCall(refreshes, providerId, current => current.refreshCredential(providerId));
    },
    async delete() {
      throw new Error(`${MANAGED_BY_SERVER}: log out on the server`);
    },
    invalidate(providerId?: string) {
      changedAt = ++generation;
      listed = undefined;
      lists.clear();
      if (providerId === undefined) {
        clearedAt = generation;
        invalidatedAt.clear();
        cache.clear();
        reads.clear();
        refreshes.clear();
        return;
      }
      invalidatedAt.set(providerId, generation);
      cache.delete(providerId);
      reads.delete(providerId);
      refreshes.delete(providerId);
    },
  };
}

function fromWire(credential: NodeCredential | null): Credential | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") return credential;
  // Refresh tokens stay on the server; Pi's type requires the field, and nothing on the node reads it.
  return { ...credential, refresh: "" };
}
