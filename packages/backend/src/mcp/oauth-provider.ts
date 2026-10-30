/**
 * Reins' side of the MCP SDK's OAuth client (docs/dev/mcp-servers.md *OAuth*): the SDK's `auth()` does
 * discovery, dynamic client registration, PKCE, the code exchange and refreshes; this keeps what it
 * produces on the server's row, encrypted (`mcp-server-store.ts`), and says where the user is sent.
 */

import { createHash, randomBytes } from "crypto";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  beginMcpSignIn, completeMcpSignIn, deleteMcpSecrets, getMcpSecret, mcpTokensAgeSeconds, setMcpSecret,
  type McpServerRow, type McpSignIn,
} from "../mcp-server-store.js";

/** The OAuth requests of a sign-in (discovery, registration, the code exchange) each get this long. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * What the provider is used for: starting a sign-in (`state` and the callback URL it is started for; it
 * hands out no tokens, so the SDK starts an authorization rather than refreshing), completing one at the
 * callback, a connection's requests, or a refresh (`refreshMcpTokens`). A connection and a refresh never
 * start a sign-in: the SDK asking for one only marks the server as needing it (`signInRequired`), keeping
 * a sign-in in progress intact.
 *
 * A connection only reads the credentials, and hands out its tokens without their refresh token: the
 * transport's own `auth()` (after a 401 the connection's refresh did not fix) then finds a sign-in needed
 * rather than refreshing outside the server's lock. A refresh writes the credentials only while the
 * stored tokens are still those it was given (`tokens`): a sign-out, a sign-in or another refresh since
 * it read them wins over its result.
 *
 * A sign-in and its callback never change the server's signed-in credentials: the SDK invalidates what a
 * failed exchange used, and a client registered for another callback URL cannot refresh the tokens of
 * the one before. A client the sign-in registers waits among its secrets; the callback keeps what the
 * exchange gives (`issuedTokens`, `client`) for `finishMcpSignIn` to make the server's.
 */
export type McpOAuthMode =
  | { kind: "sign-in"; redirectUrl: string; state: string }
  | { kind: "callback"; redirectUrl: string }
  | { kind: "connection" }
  | { kind: "refresh"; tokens: string };

type StoredClientInformation = OAuthClientInformationMixed & { redirect_uris?: string[] };

export class McpOAuthProvider implements OAuthClientProvider {
  /** Where the SDK asked to send the user, in a sign-in. */
  authorizationUrl: URL | null = null;
  /** The SDK found no usable tokens and asked for a sign-in, in a connection. */
  signInRequired = false;
  /** The callback's exchange: the tokens issued, and the client they were issued to. */
  issuedTokens: OAuthTokens | undefined;
  client: OAuthClientInformationMixed | undefined;
  /** What a refresh did: `failed` until the authorization server answers. */
  outcome: "refreshed" | "signed_out" | "superseded" | "failed" = "failed";
  /** A refresh's tokens, as stored; null once they are no longer the server's (deleted, or replaced). */
  private held: string | null;

  constructor(private readonly server: McpServerRow, private readonly mode: McpOAuthMode) {
    this.held = mode.kind === "refresh" ? mode.tokens : null;
  }

  get redirectUrl(): string | undefined {
    return this.mode.kind === "connection" || this.mode.kind === "refresh" ? this.server.oauthRedirectUrl ?? undefined : this.mode.redirectUrl;
  }

  /** In a refresh, whether the stored tokens are still those it holds; when not, it gives up. */
  private holdsTokens(): boolean {
    if (this.held !== null && getMcpSecret(this.server.id, "tokens") === this.held) return true;
    if (this.outcome !== "signed_out") this.outcome = "superseded";
    this.held = null;
    return false;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Reins",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(this.server.oauthScope ? { scope: this.server.oauthScope } : {}),
    };
  }

  state(): string {
    return this.mode.kind === "sign-in" ? this.mode.state : randomBytes(16).toString("base64url");
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.server.oauthClientId) {
      const secret = getMcpSecret(this.server.id, "client_secret");
      return { client_id: this.server.oauthClientId, ...(secret ? { client_secret: secret } : {}) };
    }
    if (this.mode.kind === "connection" || this.mode.kind === "refresh") return parseJson<StoredClientInformation>(getMcpSecret(this.server.id, "client_information"));
    if (this.mode.kind === "callback") return this.client ??= this.signInClient(this.mode.redirectUrl);
    return this.signInClient(this.mode.redirectUrl);
  }

  /** The client a sign-in through `redirectUrl` uses: the server's, else the one a sign-in registered,
   * when registered for that callback URL. None: Reins is reached at another origin, so register again. */
  private signInClient(redirectUrl: string): OAuthClientInformationMixed | undefined {
    const fits = (client: StoredClientInformation | undefined) => client && (!client.redirect_uris || client.redirect_uris.includes(redirectUrl));
    const current = parseJson<StoredClientInformation>(getMcpSecret(this.server.id, "client_information"));
    if (fits(current)) return current;
    const registered = parseJson<StoredClientInformation>(getMcpSecret(this.server.id, "sign_in_client_information"));
    return fits(registered) ? registered : undefined;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    if (this.server.oauthClientId) return;
    if (this.mode.kind === "callback") this.client = information;
    else if (this.mode.kind === "sign-in") setMcpSecret(this.server.id, "sign_in_client_information", JSON.stringify(information));
    else if (this.mode.kind === "refresh" && this.holdsTokens()) setMcpSecret(this.server.id, "client_information", JSON.stringify(information));
  }

  tokens(): OAuthTokens | undefined {
    if (this.mode.kind === "refresh") return parseJson<OAuthTokens>(this.held);
    if (this.mode.kind !== "connection") return undefined;
    const tokens = parseJson<OAuthTokens>(getMcpSecret(this.server.id, "tokens"));
    return tokens && { ...tokens, refresh_token: undefined };
  }

  saveTokens(tokens: OAuthTokens): void {
    if (this.mode.kind === "callback" || this.mode.kind === "sign-in") this.issuedTokens = tokens;
    if (this.mode.kind !== "refresh" || !this.holdsTokens()) return;
    this.held = JSON.stringify(tokens);
    setMcpSecret(this.server.id, "tokens", this.held);
    this.outcome = "refreshed";
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.mode.kind === "sign-in") this.authorizationUrl = authorizationUrl;
    else this.signInRequired = true;
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.mode.kind === "sign-in") setMcpSecret(this.server.id, "code_verifier", codeVerifier);
  }

  codeVerifier(): string {
    const verifier = getMcpSecret(this.server.id, "code_verifier");
    if (!verifier) throw new Error("No sign-in is in progress for this server");
    return verifier;
  }

  /** A sign-in drops only its own client: the server's credentials stay until it completes. Its verifier
   * goes when it ends (`endMcpSignIn`). */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const id = this.server.id;
    const all = scope === "all";
    if (all || scope === "discovery") deleteMcpSecrets(id, ["discovery"]);
    if (this.mode.kind === "sign-in" || this.mode.kind === "callback") {
      if (all || scope === "client") {
        deleteMcpSecrets(id, ["sign_in_client_information"]);
        this.client = undefined;
      }
      return;
    }
    if (this.mode.kind !== "refresh" || !(all || scope === "client" || scope === "tokens") || !this.holdsTokens()) return;
    if (all || scope === "client") deleteMcpSecrets(id, ["client_information"]);
    if (all || scope === "tokens") {
      deleteMcpSecrets(id, ["tokens"]);
      this.held = null;
      this.outcome = "signed_out";
    }
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    setMcpSecret(this.server.id, "discovery", JSON.stringify(state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return parseJson<OAuthDiscoveryState>(getMcpSecret(this.server.id, "discovery"));
  }
}

function parseJson<T>(text: string | null): T | undefined {
  return text === null ? undefined : JSON.parse(text);
}

export function hashSignInState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

const oauthFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS) });

/** What the server's refusal of an unauthenticated request says: where its resource metadata is and the
 * scope it wants (the transport's first 401, which a sign-in starts from too). A server that needs no
 * authentication accepts it instead: the session it opened is ended, as far as it lets. */
async function probe(url: string): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  const response = await oauthFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "reins", version: "1" } },
    }),
  });
  await response.body?.cancel();
  const sessionId = response.headers.get("mcp-session-id");
  if (response.ok && sessionId) {
    await oauthFetch(url, { method: "DELETE", headers: { "Mcp-Session-Id": sessionId } }).then(ended => ended.body?.cancel(), () => undefined);
  }
  return response.status === 401 ? extractWWWAuthenticateParams(response) : {};
}

/**
 * Runs the token refreshes of each server one at a time, those of its connections and the background
 * ones (`refreshAgedMcpTokens`): a refresh token is single-use where the server rotates them, so a second
 * refresh with it would fail `invalid_grant` and sign the server out. Each refresh first checks whether
 * the one before it already made it unnecessary.
 */
export class McpRefreshLock {
  private readonly chains = new Map<number, Promise<unknown>>();

  run<T>(serverId: number, work: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(serverId) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => undefined);
    this.chains.set(serverId, tail);
    void tail.then(() => { if (this.chains.get(serverId) === tail) this.chains.delete(serverId); });
    return result;
  }
}

/** Refreshes the server's tokens (`tokens`, as stored when its caller read them under the server's
 * lock). What it did: `superseded`, the tokens changed meanwhile (signed out or in again), so its result
 * was dropped; `signed_out`, the authorization server refused it and the tokens were deleted; `failed`,
 * it was not answered (unreachable, a server error), and the tokens are kept. */
async function refreshMcpTokens(server: McpServerRow, tokens: string, challenge: { resourceMetadataUrl?: URL; scope?: string } = {}): Promise<McpOAuthProvider["outcome"]> {
  const provider = new McpOAuthProvider(server, { kind: "refresh", tokens });
  // A refresh that fails other than by refusal makes `auth()` start a sign-in, which a refresh only notes.
  await auth(provider, { serverUrl: server.url, ...challenge, fetchFn: oauthFetch }).catch(() => undefined);
  return provider.outcome;
}

/**
 * Refreshes the tokens of a server nobody uses before its refresh token expires unused, as many
 * authorization servers make it do after some days (docs/dev/mcp-servers.md *OAuth*): when they were
 * issued more than `maxAgeSeconds` ago and include a refresh token.
 */
export function refreshAgedMcpTokens(server: McpServerRow, lock: McpRefreshLock, maxAgeSeconds: number): Promise<"fresh" | McpOAuthProvider["outcome"]> {
  return lock.run(server.id, async () => {
    const age = mcpTokensAgeSeconds(server.id);
    if (age === null || age < maxAgeSeconds) return "fresh";
    const tokens = getMcpSecret(server.id, "tokens");
    if (!tokens || !parseJson<OAuthTokens>(tokens)?.refresh_token) return "fresh";
    return refreshMcpTokens(server, tokens);
  });
}

/**
 * The fetch of an OAuth server's connection. A request to the MCP server refused 401 refreshes the
 * tokens under the server's lock, unless the stored access token is no longer the one refused (another
 * refresh or a sign-in replaced it): concurrent requests, and a background refresh, then refresh once,
 * and the others use its result (the transport would refresh once per refused request). It is then sent
 * again with the new access token. Without one (refused, signed out), the 401 goes to the transport,
 * which then finds a sign-in needed.
 *
 * The MCP server's requests are those on its origin that carry a bearer token: the legacy SSE transport
 * posts to an endpoint of its own, and the authorization server, often on the same origin, gets the
 * transport's own OAuth requests with a client's credentials (Basic or in the form), never a bearer token.
 */
export function oauthConnectionFetch(server: McpServerRow, lock: McpRefreshLock): FetchLike {
  const origin = new URL(server.url).origin;
  const accessToken = () => parseJson<OAuthTokens>(getMcpSecret(server.id, "tokens"))?.access_token;
  const refreshAfter = (stale: string, challenge: { resourceMetadataUrl?: URL; scope?: string }): Promise<string | null> => lock.run(server.id, async () => {
    const tokens = getMcpSecret(server.id, "tokens");
    if (tokens && parseJson<OAuthTokens>(tokens)?.access_token === stale) await refreshMcpTokens(server, tokens, challenge);
    const current = accessToken();
    return current && current !== stale ? current : null;
  });
  return async (url, init) => {
    const response = await fetch(url, init);
    if (response.status !== 401 || new URL(url).origin !== origin) return response;
    const stale = new Headers(init?.headers).get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!stale) return response;
    const fresh = await refreshAfter(stale, extractWWWAuthenticateParams(response)).catch(() => null);
    if (!fresh || fresh === stale) return response;
    await response.body?.cancel();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${fresh}`);
    return fetch(url, { ...init, headers });
  };
}

/** Starts a sign-in to `server` whose callback is `redirectUrl`: discovery and, when the server has no
 * client for it, dynamic registration; the sign-in is recorded on the row (it replaces an earlier one).
 * Returns the authorization URL to send the user to. */
export async function startMcpSignIn(server: McpServerRow, redirectUrl: string): Promise<URL> {
  const state = randomBytes(32).toString("base64url");
  const provider = new McpOAuthProvider(server, { kind: "sign-in", redirectUrl, state });
  const challenge = await probe(server.url);
  beginMcpSignIn(server.id, hashSignInState(state), redirectUrl);
  const result = await auth(provider, {
    serverUrl: server.url,
    resourceMetadataUrl: challenge.resourceMetadataUrl,
    scope: server.oauthScope ?? challenge.scope,
    fetchFn: oauthFetch,
  });
  if (result !== "REDIRECT" || !provider.authorizationUrl) throw new Error("The authorization server did not ask for a sign-in");
  return provider.authorizationUrl;
}

/** Exchanges the code the callback received for tokens: they, the client they were issued to and the
 * sign-in's callback URL become the server's. */
export async function finishMcpSignIn(server: McpServerRow, signIn: McpSignIn, code: string): Promise<void> {
  const provider = new McpOAuthProvider(server, { kind: "callback", redirectUrl: signIn.redirectUrl });
  await auth(provider, { serverUrl: server.url, authorizationCode: code, fetchFn: oauthFetch });
  if (!provider.issuedTokens) throw new Error("The authorization server issued no tokens");
  completeMcpSignIn(server.id, {
    redirectUrl: signIn.redirectUrl,
    tokens: JSON.stringify(provider.issuedTokens),
    clientInformation: server.oauthClientId || !provider.client ? null : JSON.stringify(provider.client),
  });
}
