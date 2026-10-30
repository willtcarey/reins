/**
 * A remote MCP server over HTTP for tests, with its own OAuth authorization server on the same origin
 * (metadata, dynamic client registration, authorize, token with PKCE and rotating refresh tokens), or a
 * static header, or no authentication. Optionally only the legacy SSE transport (with any of them).
 *
 * A test plays the user's browser by fetching the authorization URL (`authorize`), which answers with
 * the redirect to the callback the client registered, as an authorization server does once the user
 * approves.
 */

import { createHash, randomBytes } from "crypto";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type FakeTool = Tool & { run?: (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult> | CallToolResult };

export type FakeAuth =
  | { kind: "none" }
  | { kind: "header"; name: string; value: string }
  /** `preRegistered`: no registration endpoint; only this client may authorize, at these redirect URIs. */
  | { kind: "oauth"; preRegistered?: { clientId: string; clientSecret: string } };

interface Client { secret: string | null; redirectUris: string[] }
interface Grant { clientId: string; redirectUri: string; challenge: string; scope: string | null; resource: string | null }

export interface FakeMcpServer {
  readonly url: string;
  readonly origin: string;
  /** Its tools: change the array in place (then `sendToolListChanged`). */
  readonly tools: FakeTool[];
  /** Every client registered dynamically, by ID. */
  readonly registrations: Map<string, Client>;
  /** The grant types of every token request, in order. */
  readonly tokenRequests: string[];
  /** Follows an authorization URL as the user's browser does once they approve: the redirect URL it
   * answers with (to the client's callback, with `code` and `state`). */
  authorize(authorizationUrl: string): Promise<URL>;
  /** Access tokens stop working; refresh tokens still do (an access token's expiry). */
  expireAccessTokens(): void;
  /** Every token stops working, refresh tokens too (the user revoked the app). */
  revokeTokens(): void;
  /** Forgets every MCP session, as a restarted server does. */
  dropSessions(): void;
  /** Tells every connected client its tool list changed. */
  sendToolListChanged(): Promise<void>;
  /** The number of MCP sessions initialized so far. */
  readonly sessionsOpened: number;
  /** The number of MCP sessions open now (not ended by the client nor dropped). */
  readonly openSessions: number;
  /** How many `tools/list` requests it received. */
  readonly toolListings: number;
  /** Makes `tools/list` wait until the returned function is called. */
  holdToolLists(): () => void;
  /** Makes refresh token requests wait, once counted in `tokenRequests`, until the returned function is called. */
  holdRefreshes(): () => void;
  stop(): Promise<void>;
}

function token(): string {
  return randomBytes(16).toString("hex");
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function authorize(authorizationUrl: string): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new Error(`authorize answered ${response.status}: ${await response.text()}`);
  return new URL(location);
}

/** An echo tool: answers its `text` argument. */
export const echoTool: FakeTool = {
  name: "echo",
  description: "Answers its text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: (args) => textResult(String(args.text)),
};

interface FakeState { tools: FakeTool[]; toolListings: number; toolListHold: Promise<void> | null; refreshHold: Promise<void> | null }

function mcpServerFor(fake: FakeState): Server {
  const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    fake.toolListings++;
    await fake.toolListHold;
    return { tools: fake.tools.map(({ run: _run, ...tool }) => tool) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = fake.tools.find(candidate => candidate.name === request.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool ${request.params.name}` }], isError: true };
    return tool.run ? tool.run(request.params.arguments ?? {}, extra.signal) : textResult("ok");
  });
  return server;
}

export async function startFakeMcpServer({ auth = { kind: "none" }, tools = [echoTool], legacySse = false }: { auth?: FakeAuth; tools?: FakeTool[]; legacySse?: boolean } = {}): Promise<FakeMcpServer> {
  const registrations = new Map<string, Client>();
  const clients = new Map<string, Client>();
  if (auth.kind === "oauth" && auth.preRegistered) {
    clients.set(auth.preRegistered.clientId, { secret: auth.preRegistered.clientSecret, redirectUris: [] });
  }
  const grants = new Map<string, Grant>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>();
  const tokenRequests: string[] = [];
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server }>();
  const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  let sessionsOpened = 0;
  let origin = "";
  const mcpPath = legacySse ? "/sse" : "/mcp";

  const fake: FakeState = { tools, toolListings: 0, toolListHold: null, refreshHold: null };

  function issueTokens(clientId: string): Record<string, unknown> {
    const access = token();
    const refresh = token();
    accessTokens.add(access);
    refreshTokens.set(refresh, clientId);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh };
  }

  /** The client a token request authenticates as (basic or post), or null. */
  function tokenClient(req: Request, form: URLSearchParams): string | null {
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1];
    if (basic) {
      const [id, pass] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
      clientId = id ?? null;
      secret = pass ?? null;
    }
    const client = clientId ? clients.get(clientId) : undefined;
    if (!client || !clientId) return null;
    if (client.secret !== null && client.secret !== secret) return null;
    return clientId;
  }

  function authorized(headers: Headers): boolean {
    if (auth.kind === "none") return true;
    if (auth.kind === "header") return headers.get(auth.name) === auth.value;
    const bearer = headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    return bearer !== undefined && accessTokens.has(bearer);
  }

  function unauthorized(): Response {
    const headers: Record<string, string> = auth.kind === "oauth"
      ? { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource${mcpPath}"` }
      : {};
    return json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }, 401, headers);
  }

  async function handleMcp(req: Request): Promise<Response> {
    if (!authorized(req.headers)) return unauthorized();
    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, 404);
      return session.transport.handleRequest(req);
    }
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, server }); sessionsOpened++; },
      onsessionclosed: (id) => { sessions.delete(id); },
    });
    const server = mcpServerFor(fake);
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  async function handleOAuth(req: Request, url: URL): Promise<Response | null> {
    if (auth.kind !== "oauth") return null;
    if (url.pathname === `/.well-known/oauth-protected-resource${mcpPath}`) {
      return json({ resource: `${origin}${mcpPath}`, authorization_servers: [origin], scopes_supported: ["tools"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(auth.preRegistered ? {} : { registration_endpoint: `${origin}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST" && !auth.preRegistered) {
      const body: { redirect_uris: string[]; token_endpoint_auth_method?: string } = await req.json();
      const clientId = `client-${token()}`;
      const secret = body.token_endpoint_auth_method === "none" ? null : token();
      const client = { secret, redirectUris: body.redirect_uris };
      clients.set(clientId, client);
      registrations.set(clientId, client);
      return json({ ...body, client_id: clientId, ...(secret ? { client_secret: secret } : {}), client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
    }
    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const client = clients.get(clientId);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      if (!client) return json({ error: "invalid_client" }, 400);
      // A pre-registered client's redirect URIs are configured with the provider, not here.
      if (client.redirectUris.length && !client.redirectUris.includes(redirectUri)) return json({ error: "invalid_redirect_uri" }, 400);
      if (url.searchParams.get("code_challenge_method") !== "S256") return json({ error: "invalid_request" }, 400);
      const code = token();
      grants.set(code, {
        clientId,
        redirectUri,
        challenge: url.searchParams.get("code_challenge") ?? "",
        scope: url.searchParams.get("scope"),
        resource: url.searchParams.get("resource"),
      });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) location.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { Location: location.href } });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const grantType = form.get("grant_type") ?? "";
      tokenRequests.push(grantType);
      const clientId = tokenClient(req, form);
      if (!clientId) return json({ error: "invalid_client" }, 401);
      if (grantType === "authorization_code") {
        const grant = grants.get(form.get("code") ?? "");
        grants.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!grant || grant.clientId !== clientId || grant.redirectUri !== form.get("redirect_uri") || grant.challenge !== challenge) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json(issueTokens(clientId));
      }
      if (grantType === "refresh_token") {
        await fake.refreshHold;
        const refresh = form.get("refresh_token") ?? "";
        if (refreshTokens.get(refresh) !== clientId) return json({ error: "invalid_grant" }, 400);
        refreshTokens.delete(refresh);
        return json(issueTokens(clientId));
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return null;
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const oauth = await handleOAuth(req, url);
    if (oauth) return oauth;
    if (url.pathname === "/mcp") return handleMcp(req);
    return new Response("Not found", { status: 404 });
  }

  const build = (transport: Pick<FakeMcpServer, "url" | "origin" | "dropSessions" | "sendToolListChanged" | "stop">): FakeMcpServer => ({
    ...transport,
    tools,
    registrations,
    tokenRequests,
    authorize,
    expireAccessTokens: () => accessTokens.clear(),
    revokeTokens: () => { accessTokens.clear(); refreshTokens.clear(); },
    get sessionsOpened() { return sessionsOpened; },
    get openSessions() { return (legacySse ? sseSessions : sessions).size; },
    get toolListings() { return fake.toolListings; },
    holdToolLists: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      fake.toolListHold = promise;
      return () => { fake.toolListHold = null; resolve(); };
    },
    holdRefreshes: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      fake.refreshHold = promise;
      return () => { fake.refreshHold = null; resolve(); };
    },
  });

  if (legacySse) {
    const node = await startLegacySse(fake, sseSessions, {
      opened: () => sessionsOpened++,
      oauth: req => handleOAuth(req, new URL(req.url)),
      authorized,
      unauthorized,
    });
    origin = node.origin;
    return build({
      url: `${origin}/sse`,
      origin,
      dropSessions: () => sseSessions.clear(),
      sendToolListChanged: async () => { await Promise.all([...sseSessions.values()].map(session => session.server.sendToolListChanged())); },
      stop: async () => {
        await Promise.all([...sseSessions.values()].map(session => session.server.close()));
        node.server.closeAllConnections();
        await new Promise<void>(resolve => node.server.close(() => resolve()));
      },
    });
  }

  const server = Bun.serve({ port: 0, fetch: fetchHandler, idleTimeout: 0 });
  origin = `http://localhost:${server.port}`;
  return build({
    url: `${origin}/mcp`,
    origin,
    dropSessions: () => sessions.clear(),
    sendToolListChanged: async () => { await Promise.all([...sessions.values()].map(session => session.server.sendToolListChanged())); },
    stop: async () => {
      await Promise.all([...sessions.values()].map(session => session.server.close()));
      sessions.clear();
      await server.stop(true);
    },
  });
}

interface LegacyHandlers {
  opened: () => void;
  /** The authorization server's answer, or null when the request is not for it. */
  oauth: (req: Request) => Promise<Response | null>;
  authorized: (headers: Headers) => boolean;
  unauthorized: () => Response;
}

/** A server that speaks only the legacy HTTP+SSE transport (`GET /sse`, `POST /messages`), which needs
 * Node's response objects; the authorization server's requests go through as web requests. */
async function startLegacySse(
  fake: FakeState,
  sessions: Map<string, { transport: SSEServerTransport; server: Server }>,
  { opened, oauth, authorized, unauthorized }: LegacyHandlers,
): Promise<{ server: NodeServer; origin: string }> {
  let origin = "";
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", origin);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    if (url.pathname !== "/sse" && url.pathname !== "/messages") {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(await Array.fromAsync(req));
      const answer = await oauth(new Request(url, { method: req.method, headers, body }));
      if (answer) return send(res, answer);
      res.writeHead(404).end();
      return;
    }
    if (!authorized(headers)) return send(res, unauthorized());
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      const mcp = mcpServerFor(fake);
      sessions.set(transport.sessionId, { transport, server: mcp });
      res.on("close", () => sessions.delete(transport.sessionId));
      opened();
      await mcp.connect(transport);
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const session = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!session) { res.writeHead(404).end(); return; }
      await session.transport.handlePostMessage(req, res);
      return;
    }
    // What a streamable HTTP client's first POST gets from a legacy server.
    res.writeHead(405).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The legacy SSE server has no port");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin };
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
