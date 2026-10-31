/**
 * MCP Server Routes (docs/dev/mcp-servers.md), under the extension's API, `/api/extensions/mcp`:
 *
 *   GET    /servers               — every server's view, in name order (secrets only as `has…`)
 *   POST   /servers               — add one: 201 its view (400 invalid, 409 name taken)
 *   PATCH  /servers/:id           — change it: what is left out is kept, a secret given as null is
 *                                    removed; changing its URL, auth kind or OAuth client signs it out
 *   DELETE /servers/:id           — remove it and its credentials: 204
 *   POST   /servers/:id/test      — connect afresh and list its tools: its view, whose status says how it went
 *   POST   /servers/:id/sign-in   — start an OAuth sign-in: {authorizationUrl, callbackUrl}, the first to open
 *                                    in a window (409: not OAuth; 502: discovery or registration failed)
 *   POST   /servers/:id/sign-out  — forget its tokens: its view
 *   GET    /servers/:id/tools     — its tools {name, title?, description?, inputSchema, …} (409 disabled or
 *                                    needs sign-in, 502 unreachable)
 *
 * And a page for the browser, under the extension's pages (`CALLBACK_PATH`):
 *
 *   GET    /extensions/mcp/oauth/callback — where the authorization server sends the user's window back
 *                                           (`code`, `state` or `error`): an HTML page that closes itself
 *
 * Browsers hear of changes as the extension's messages (`McpMessage`): `mcp_server_updated {server}`
 * (created, changed, signed in or out, a failure recorded or cleared) and `mcp_server_removed {serverId}`.
 */

import type { TSchema, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Disposer, RouteHandler, RouteRequest, Routes } from "@reins/sdk/server";
import { McpServerUnavailableError } from "./connections.js";
import { McpServerInputSchema, McpServerNotFoundError, McpServerUpdateSchema, McpSignInError, type McpServers } from "./servers.js";
import { InvalidMcpServerError, McpServerAuthError, McpServerNameTakenError, type McpServerModel } from "./server.js";

/** The OAuth callback page's path under the extension's pages. */
export const CALLBACK_PATH = "/oauth/callback";

/** An error answered with its status and `{ error: message }`. */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RouteError";
  }
}

function translateMcpError(error: unknown): never {
  if (error instanceof McpServerNotFoundError) throw new RouteError(404, error.message);
  if (error instanceof InvalidMcpServerError) throw new RouteError(400, error.message);
  if (error instanceof McpServerNameTakenError || error instanceof McpServerAuthError) throw new RouteError(409, error.message);
  if (error instanceof McpServerUnavailableError) throw new RouteError(error.status.state === "error" ? 502 : 409, error.message);
  throw error;
}

async function translated<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return translateMcpError(error);
  }
}

/** A handler whose `RouteError` is its answer. */
function answering(handler: RouteHandler): RouteHandler {
  return async request => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof RouteError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  };
}

async function parseBody<T extends TSchema>(schema: T, req: Request): Promise<Static<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new RouteError(400, "Invalid JSON in request body"); }
  try {
    return Value.Parse(schema, raw);
  } catch {
    const first = Value.Errors(schema, raw).First();
    throw new RouteError(400, `Invalid request body: ${first ? `${first.path || "/"}: ${first.message}` : "does not match"}`);
  }
}

function serverId({ params }: RouteRequest): number {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new RouteError(400, `Invalid id: ${params.id}`);
  return id;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/** The page the sign-in window lands on: it says how it went and closes itself (a browser keeps a window
 * it did not open by script, so the text stays useful). */
function callbackPage(status: number, title: string, detail: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:14px system-ui,sans-serif;background:#18181b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:28rem;padding:1.5rem}p{color:#a1a1aa}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>
${status === 200 ? "<script>setTimeout(() => window.close(), 1500)</script>" : ""}</body></html>`;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export function registerMcpRoutes(routes: Routes, servers: McpServers): Disposer {
  const { api, pages } = routes;
  /** The server the path names; throws its `McpServerNotFoundError` (translate it). */
  const serverOf = (request: RouteRequest): McpServerModel => servers.get(serverId(request));

  const removals = [
    api.get("/servers", answering(() => Response.json(servers.list()))),

    api.post("/servers", answering(async ({ req }) => {
      const body = await parseBody(McpServerInputSchema, req);
      return Response.json(await translated(() => servers.create(body)), { status: 201 });
    })),

    api.patch("/servers/:id", answering(async (request) => {
      const body = await parseBody(McpServerUpdateSchema, request.req);
      return Response.json(await translated(() => serverOf(request).update(body)));
    })),

    api.delete("/servers/:id", answering(async (request) => {
      await translated(() => serverOf(request).remove());
      return new Response(null, { status: 204 });
    })),

    api.post("/servers/:id/test", answering(async (request) =>
      Response.json(await translated(async () => (await serverOf(request).test(request.req.signal)).server)))),

    api.post("/servers/:id/sign-in", answering(async (request) => {
      if (!request.origin) throw new RouteError(400, "No usable Host header");
      const target = await translated(() => serverOf(request));
      try {
        return Response.json(await target.startSignIn(`${request.origin}${routes.pagePath(CALLBACK_PATH)}`));
      } catch (error) {
        if (error instanceof McpServerAuthError) translateMcpError(error);
        throw new RouteError(502, `Could not start signing in: ${error instanceof Error ? error.message : String(error)}`);
      }
    })),

    api.post("/servers/:id/sign-out", answering(async (request) => Response.json(await translated(() => serverOf(request).signOut())))),

    api.get("/servers/:id/tools", answering(async (request) =>
      Response.json(await translated(() => serverOf(request).listTools({ signal: request.req.signal }))))),

    pages.get(CALLBACK_PATH, async ({ url }) => {
      const query = url.searchParams;
      try {
        const server = await servers.finishSignIn({
          state: query.get("state"),
          code: query.get("code"),
          error: query.get("error"),
          errorDescription: query.get("error_description"),
        });
        return callbackPage(200, `Signed in to ${server.name}`, "You can close this window and return to Reins.");
      } catch (error) {
        if (!(error instanceof McpSignInError)) throw error;
        return callbackPage(400, error.serverName ? `Could not sign in to ${error.serverName}` : "Could not sign in", error.message);
      }
    }),
  ];
  return () => { for (const remove of removals) void remove(); };
}
