/**
 * MCP Server Routes (docs/dev/mcp-servers.md)
 *
 *   GET    /api/mcp-servers               — every server's view, in name order (secrets only as `has…`)
 *   POST   /api/mcp-servers               — add one: 201 its view (400 invalid, 409 name taken)
 *   PATCH  /api/mcp-servers/:id           — change it: what is left out is kept, a secret given as null is
 *                                            removed; changing its URL, auth kind or OAuth client signs it out
 *   DELETE /api/mcp-servers/:id           — remove it and its credentials: 204
 *   POST   /api/mcp-servers/:id/test      — connect afresh and list its tools: its view, with the status
 *   POST   /api/mcp-servers/:id/sign-in   — start an OAuth sign-in: {authorizationUrl, callbackUrl}, the first to open in a window (409:
 *                                            not OAuth; 502: discovery or registration failed)
 *   POST   /api/mcp-servers/:id/sign-out  — forget its tokens: its view
 *   GET    /api/mcp-servers/:id/tools     — its tools {name, title?, description?, inputSchema, …} (409 disabled
 *                                            or needs sign-in, 502 unreachable)
 *
 * Outside `/api`, a page for the browser (`API.mcpOAuthCallback`):
 *
 *   GET    /oauth/mcp/callback           — where the authorization server sends the user's window back
 *                                            (`code`, `state` or `error`): an HTML page that closes itself
 *
 * Browsers hear of changes over the WebSocket: `mcp_server_updated {server}` (created, changed, signed in or
 * out, its status or tools changed) and `mcp_server_removed {serverId}`.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { requestOrigin } from "../nodes/node-link.js";
import { McpServerUnavailableError } from "../mcp/connections.js";
import { McpServerInputSchema, McpServerNotFoundError, McpServerUpdateSchema, McpSignInError } from "../models/mcp-servers.js";
import { InvalidMcpServerError, McpServerAuthError, McpServerNameTakenError, type McpServerModel } from "../models/mcp-server.js";
import { parseBody, parseIntParam } from "./validate.js";

function translateMcpError(error: unknown): never {
  if (error instanceof McpServerNotFoundError) notFound(error.message);
  if (error instanceof InvalidMcpServerError) badRequest(error.message);
  if (error instanceof McpServerNameTakenError || error instanceof McpServerAuthError) conflict(error.message);
  if (error instanceof McpServerUnavailableError) {
    throw new HttpError(error.status.state === "error" ? 502 : 409, error.message);
  }
  throw error;
}

async function translated<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return translateMcpError(error);
  }
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

export function registerMcpServerRoutes(router: RouterGroup) {
  /** The server the path names; throws its `McpServerNotFoundError` (translate it). */
  const serverOf = (ctx: RouteContext): McpServerModel => ctx.models.mcpServers.get(parseIntParam(ctx.params, "id"));

  router.get(API.mcpServers, (ctx) => Response.json(ctx.models.mcpServers.list()));

  router.post(API.mcpServers, async (ctx) => {
    const body = await parseBody(McpServerInputSchema, ctx.req);
    return Response.json(await translated(() => ctx.models.mcpServers.create(body)), { status: 201 });
  });

  router.patch(`${API.mcpServers}/:id`, async (ctx) => {
    const body = await parseBody(McpServerUpdateSchema, ctx.req);
    return Response.json(await translated(() => serverOf(ctx).update(body)));
  });

  router.delete(`${API.mcpServers}/:id`, async (ctx) => {
    await translated(() => serverOf(ctx).remove());
    return new Response(null, { status: 204 });
  });

  router.post(`${API.mcpServers}/:id/test`, async (ctx) => {
    return Response.json(await translated(() => serverOf(ctx).test(ctx.req.signal)));
  });

  router.post(`${API.mcpServers}/:id/sign-in`, async (ctx) => {
    const origin = requestOrigin(ctx.req);
    if (!origin) badRequest("No usable Host header");
    const target = await translated(() => serverOf(ctx));
    try {
      return Response.json(await target.startSignIn(`${origin}${API.mcpOAuthCallback}`));
    } catch (error) {
      if (error instanceof McpServerAuthError) translateMcpError(error);
      throw new HttpError(502, `Could not start signing in: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  router.post(`${API.mcpServers}/:id/sign-out`, async (ctx) => {
    return Response.json(await translated(() => serverOf(ctx).signOut()));
  });

  router.get(`${API.mcpServers}/:id/tools`, async (ctx) => {
    return Response.json(await translated(() => serverOf(ctx).listTools({ signal: ctx.req.signal })));
  });

  router.get(API.mcpOAuthCallback, async (ctx) => {
    const query = ctx.url.searchParams;
    try {
      const server = await ctx.models.mcpServers.finishSignIn({
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
  });
}
