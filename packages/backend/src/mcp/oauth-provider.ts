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
  beginMcpSignIn, deleteMcpSecrets, getMcpSecret, setMcpSecret, type McpServerRow,
} from "../mcp-server-store.js";

/** The OAuth requests of a sign-in (discovery, registration, the code exchange) each get this long. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * What the provider is used for: starting a sign-in (`state` and the callback URL it is started for; it
 * hands out no tokens, so the SDK starts an authorization rather than refreshing), completing one at the
 * callback, or a connection's requests, which refresh but never start a sign-in: the SDK asking for one
 * only marks the server as needing it (`signInRequired`), keeping a sign-in in progress intact.
 */
export type McpOAuthMode =
  | { kind: "sign-in"; redirectUrl: string; state: string }
  | { kind: "callback" }
  | { kind: "connection" };

export class McpOAuthProvider implements OAuthClientProvider {
  /** Where the SDK asked to send the user, in a sign-in. */
  authorizationUrl: URL | null = null;
  /** The SDK found no usable tokens and asked for a sign-in, in a connection. */
  signInRequired = false;

  constructor(private readonly server: McpServerRow, private readonly mode: McpOAuthMode) {}

  get redirectUrl(): string | undefined {
    return this.mode.kind === "sign-in" ? this.mode.redirectUrl : this.server.oauthRedirectUrl ?? undefined;
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
    const stored = parseJson<OAuthClientInformationMixed & { redirect_uris?: string[] }>(getMcpSecret(this.server.id, "client_information"));
    // Registered for another callback URL (Reins reached at another origin): register again for this one.
    if (stored && this.mode.kind === "sign-in" && stored.redirect_uris && !stored.redirect_uris.includes(this.mode.redirectUrl)) return undefined;
    return stored;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    if (this.server.oauthClientId) return;
    setMcpSecret(this.server.id, "client_information", JSON.stringify(information));
  }

  tokens(): OAuthTokens | undefined {
    if (this.mode.kind === "sign-in") return undefined;
    return parseJson<OAuthTokens>(getMcpSecret(this.server.id, "tokens"));
  }

  saveTokens(tokens: OAuthTokens): void {
    setMcpSecret(this.server.id, "tokens", JSON.stringify(tokens));
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

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const id = this.server.id;
    if (scope === "all" || scope === "client") deleteMcpSecrets(id, ["client_information"]);
    if (scope === "all" || scope === "tokens") deleteMcpSecrets(id, ["tokens"]);
    if ((scope === "all" || scope === "verifier") && this.mode.kind === "sign-in") deleteMcpSecrets(id, ["code_verifier"]);
    if (scope === "all" || scope === "discovery") deleteMcpSecrets(id, ["discovery"]);
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
 * scope it wants (the transport's first 401, which a sign-in starts from too). */
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
  return response.status === 401 ? extractWWWAuthenticateParams(response) : {};
}

/**
 * The fetch of an OAuth server's connection. A request to the MCP endpoint refused 401 refreshes the
 * tokens once, whichever of the connection's concurrent requests sees it first: the others wait and use
 * its result, since a refresh token is single-use where the server rotates them (the transport would
 * refresh once per refused request). It is then sent again with the new access token. Without one (the
 * refresh failed), the 401 goes to the transport, which then finds a sign-in needed.
 */
export function oauthConnectionFetch(server: McpServerRow, provider: McpOAuthProvider): FetchLike {
  const endpoint = new URL(server.url);
  let chain: Promise<unknown> = Promise.resolve();
  const refreshAfter = (stale: string | undefined, challenge: { resourceMetadataUrl?: URL; scope?: string }): Promise<string | null> => {
    const refreshed = chain.then(async () => {
      const current = provider.tokens()?.access_token;
      if (current && current !== stale) return current;
      const result = await auth(provider, { serverUrl: server.url, ...challenge, fetchFn: oauthFetch });
      return result === "AUTHORIZED" ? provider.tokens()?.access_token ?? null : null;
    });
    chain = refreshed.catch(() => undefined);
    return refreshed;
  };
  return async (url, init) => {
    const response = await fetch(url, init);
    const target = new URL(url);
    if (response.status !== 401 || target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) return response;
    const stale = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "");
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

/** Exchanges the code the callback received for tokens, which are stored. */
export async function finishMcpSignIn(server: McpServerRow, code: string): Promise<void> {
  await auth(new McpOAuthProvider(server, { kind: "callback" }), { serverUrl: server.url, authorizationCode: code, fetchFn: oauthFetch });
}
