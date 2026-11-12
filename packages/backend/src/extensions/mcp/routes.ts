/**
 * The MCP extension's HTTP API (`mcpApi`, api.ts: `POST /api/extensions/mcp/<method>`) and its page for the
 * browser, the OAuth callback (`GET /extensions/mcp/oauth/callback`, `CALLBACK_PATH`), where the authorization
 * server sends the user's window back (`code`, `state` or `error`): an HTML page that closes itself.
 *
 * Browsers hear of changes as the extension's messages (`McpMessage`): `mcp_server_updated {server}`
 * (created, changed, signed in or out, a failure recorded or cleared) and `mcp_server_removed {serverId}`.
 */

import type { Disposer, Http } from "@reins/sdk/server";
import { mcpApi } from "./api.js";
import { McpServerUnavailableError } from "./connections.js";
import { McpServerSessionRequiredError } from "./stdio.js";
import { McpServerNotFoundError, McpSignInError, type McpServers } from "./servers.js";
import { InvalidMcpServerError } from "./input.js";
import { McpServerAuthError, McpServerNameTakenError } from "./server.js";

/** The OAuth callback page's path under the extension's pages. */
export const CALLBACK_PATH = "/oauth/callback";

/** An error the host answers with its status and `{ error: message }`. */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RouteError";
  }
}

function translateMcpError(error: unknown): never {
  if (error instanceof McpServerNotFoundError) throw new RouteError(404, error.message);
  if (error instanceof InvalidMcpServerError) throw new RouteError(400, error.message);
  if (error instanceof McpServerSessionRequiredError) throw new RouteError(400, `${error.message}: use it from a session first (an agent can run reins.mcp.test)`);
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

export function registerMcpRoutes(http: Http, servers: McpServers): Disposer {
  /** The server of that ID; throws its `McpServerNotFoundError` (translate it). */
  const serverOf = (id: number) => servers.get(id);

  const removals = [
    http.handle(mcpApi, {
      list: () => servers.list(),
      create: ({ input }) => translated(() => servers.create(input)),
      update: ({ input }) => translated(() => serverOf(input.id).update(input.changes)),
      remove: ({ input }) => translated(() => serverOf(input.id).remove()),
      test: ({ input, signal }) => translated(async () => (await serverOf(input.id).test(signal)).server),
      signIn: async ({ input, origin }) => {
        if (!origin) throw new RouteError(400, "No usable Host header");
        const target = await translated(() => serverOf(input.id));
        try {
          return await target.startSignIn(`${origin}${http.pagePath(CALLBACK_PATH)}`);
        } catch (error) {
          if (error instanceof McpServerAuthError) translateMcpError(error);
          throw new RouteError(502, `Could not start signing in: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      signOut: ({ input }) => translated(() => serverOf(input.id).signOut()),
      tools: ({ input, signal }) => translated(() => serverOf(input.id).listTools({ signal })),
    }),

    http.page(CALLBACK_PATH, async ({ url }) => {
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
