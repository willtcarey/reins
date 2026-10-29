/**
 * MCP server API function definitions: managing the remote MCP servers of Settings → MCP servers
 * (docs/dev/mcp-servers.md), and listing and calling their tools by name.
 */

import { Type } from "@sinclair/typebox";
import { API } from "../api-paths.js";
import { McpServerInputSchema, McpServerUpdateSchema, type McpServerView } from "../models/mcp-servers.js";
import { McpAuthKindSchema } from "../mcp-server-store.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

const SIGN_IN = "An OAuth server is signed in to with mcp.signIn (or by the user, under Settings → MCP servers).";

export const McpSignInSchema = Type.Object({
  authorizationUrl: Type.String({ description: "The page to send the user to, to sign in and approve Reins." }),
  callbackUrl: Type.String({ description: "Where their browser comes back with the code once they approve." }),
});

export const McpServerSchema = Type.Object({
  id: Type.Number(),
  name: Type.String({ description: "Unique; lowercase letters, digits and hyphens. Its tools will be namespaced under it." }),
  description: Type.String(),
  url: Type.String({ description: "Its MCP endpoint (streamable HTTP, or legacy HTTP+SSE)." }),
  authKind: McpAuthKindSchema,
  headerName: Type.Union([Type.String(), Type.Null()], { description: "Header auth: the header sent with every request." }),
  hasHeaderValue: Type.Boolean({ description: "Header auth: whether its value is set (it is never returned)." }),
  oauthClientId: Type.Union([Type.String(), Type.Null()], { description: "OAuth: a pre-registered client; null registers Reins dynamically." }),
  hasClientSecret: Type.Boolean({ description: "OAuth: whether the pre-registered client's secret is set (it is never returned)." }),
  oauthScope: Type.Union([Type.String(), Type.Null()], { description: "OAuth: the scope sign-ins ask for; null for the server's own." }),
  enabled: Type.Boolean(),
  signedIn: Type.Boolean({ description: "OAuth: whether Reins holds tokens for it." }),
  status: Type.Union([
    Type.Literal("connected"), Type.Literal("connecting"), Type.Literal("not_connected"),
    Type.Literal("needs_sign_in"), Type.Literal("error"), Type.Literal("disabled"),
  ], { description: `Whether Reins can use it now. ${SIGN_IN}` }),
  error: Type.Union([Type.String(), Type.Null()], { description: "Why its last attempt failed, when status is error." }),
  toolCount: Type.Union([Type.Number(), Type.Null()], { description: "How many tools it listed last; null before it listed any." }),
});

const serverParam = Type.Union([Type.String(), Type.Number()], { description: "Its name or ID." });

export const McpToolSchema = Type.Object({
  name: Type.String({ description: "What mcp.call names it by." }),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  inputSchema: Type.Unknown({ description: "The JSON Schema of its arguments." }),
  outputSchema: Type.Optional(Type.Unknown({ description: "The JSON Schema of its structuredContent, when it declares one." })),
  annotations: Type.Optional(Type.Unknown({ description: "Hints such as readOnlyHint and destructiveHint." })),
});

export const McpToolResultSchema = Type.Object({
  content: Type.Array(Type.Unknown(), { description: "Content blocks, e.g. { type: \"text\", text }." }),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean({ description: "True when the tool itself reports a failure (its content says why)." })),
});

function summary(server: McpServerView) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    url: server.url,
    authKind: server.authKind,
    headerName: server.headerName,
    hasHeaderValue: server.hasHeaderValue,
    oauthClientId: server.oauthClientId,
    hasClientSecret: server.hasClientSecret,
    oauthScope: server.oauthScope,
    enabled: server.enabled,
    signedIn: server.signedIn,
    status: server.status.state,
    error: server.status.state === "error" ? server.status.message : null,
    toolCount: server.toolCount,
  };
}

const servers = (ctx: ApiContext) => ctx.models.mcpServers;

export const mcpListFunction = defineFunction({
  name: "mcp.list",
  description: "List the remote MCP servers set up in Reins (Settings → MCP servers), in name order, with each one's status. Secrets are only said to be set.",
  parameters: Type.Object({}),
  returns: Type.Array(McpServerSchema),
  tags: ["mcp", "servers", "list", "status", "read"],
  execute: (_params, ctx) => servers(ctx).list().map(summary),
});

export const mcpGetFunction = defineFunction({
  name: "mcp.get",
  description: "Get one MCP server by name or ID. Throws for an unknown one, naming those there are.",
  parameters: Type.Object({ server: serverParam }),
  returns: McpServerSchema,
  tags: ["mcp", "server", "get", "status", "read"],
  execute: (params, ctx) => summary(servers(ctx).find(params.server).view()),
});

export const mcpAddFunction = defineFunction({
  name: "mcp.add",
  description:
    "Add a remote MCP server (HTTP; stdio is not supported). Header auth needs headerName and headerValue. " +
    `It is not connected until used: mcp.test connects and reports. ${SIGN_IN}\n\n` +
    "  await api.mcp.add({ name: \"executor\", url: \"https://executor.example.com/mcp\", authKind: \"oauth\" });\n" +
    "  return await api.mcp.test(\"executor\");",
  parameters: Type.Object({ server: McpServerInputSchema }),
  returns: McpServerSchema,
  tags: ["mcp", "server", "add", "create", "write", "oauth", "header", "api key"],
  execute: (params, ctx) => summary(servers(ctx).create(params.server)),
});

export const mcpUpdateFunction = defineFunction({
  name: "mcp.update",
  description:
    "Change an MCP server: what is left out is kept; a secret given as null is removed. Changing its url, authKind or " +
    "oauthClientId signs it out. `enabled: false` disables it.",
  parameters: Type.Object({ server: serverParam, changes: McpServerUpdateSchema }),
  returns: McpServerSchema,
  async: true,
  tags: ["mcp", "server", "update", "edit", "enable", "disable", "write"],
  execute: async (params, ctx) => summary(await servers(ctx).find(params.server).update(params.changes)),
});

export const mcpRemoveFunction = defineFunction({
  name: "mcp.remove",
  description: "Remove an MCP server and its credentials for good.",
  parameters: Type.Object({ server: serverParam }),
  returns: Type.Void(),
  async: true,
  tags: ["mcp", "server", "remove", "delete", "write"],
  execute: async (params, ctx) => { await servers(ctx).find(params.server).remove(); },
});

export const mcpTestFunction = defineFunction({
  name: "mcp.test",
  description:
    "Connect to an MCP server afresh and list its tools: the server after the attempt (status connected and its " +
    "toolCount, or error with why, or needs_sign_in).",
  parameters: Type.Object({ server: serverParam }),
  returns: McpServerSchema,
  async: true,
  tags: ["mcp", "server", "test", "connect", "status", "check"],
  execute: async (params, ctx) => summary(await servers(ctx).find(params.server).test(ctx.signal)),
});

export const mcpSignOutFunction = defineFunction({
  name: "mcp.signOut",
  description: "Forget an OAuth MCP server's tokens; it then needs sign-in.",
  parameters: Type.Object({ server: serverParam }),
  returns: McpServerSchema,
  async: true,
  tags: ["mcp", "server", "sign out", "logout", "oauth", "tokens", "write"],
  execute: async (params, ctx) => summary(await servers(ctx).find(params.server).signOut()),
});

export const mcpSignInFunction = defineFunction({
  name: "mcp.signIn",
  description:
    "Start an OAuth sign-in to an MCP server: give the user `authorizationUrl` to open. Once they approve, their " +
    "browser goes to `callbackUrl`. If it reaches Reins there, the sign-in completes by itself (mcp.get shows " +
    "signedIn). If that page does not load (Reins is not at that address for their browser), ask them for the URL " +
    "in their address bar and pass it to mcp.finishSignIn. The sign-in must end within 15 minutes; starting another " +
    "replaces it.\n\n" +
    "  const { authorizationUrl } = await api.mcp.signIn(\"executor\");\n" +
    "  return authorizationUrl; // for the user to open",
  parameters: Type.Object({
    server: serverParam,
    callbackOrigin: Type.Optional(Type.String({
      description: `Reins' address as the user's browser opens it, e.g. https://reins.example.com: the callback is its ${API.mcpOAuthCallback}. ` +
        "By default the one of the latest completed sign-in, else http://localhost:<Reins' port>. A server's pre-registered " +
        "client accepts only the callback registered with it.",
    })),
  }),
  returns: McpSignInSchema,
  async: true,
  tags: ["mcp", "server", "sign in", "login", "oauth", "authorize", "url"],
  execute: async (params, ctx) => {
    const server = servers(ctx).find(params.server);
    if (params.callbackOrigin === undefined) return server.startSignIn();
    let origin: string;
    try { origin = new URL(params.callbackOrigin).origin; } catch { throw new Error(`Not a URL: ${params.callbackOrigin}`); }
    return server.startSignIn(`${origin}${API.mcpOAuthCallback}`);
  },
});

export const mcpFinishSignInFunction = defineFunction({
  name: "mcp.finishSignIn",
  description:
    "Complete an mcp.signIn whose callback page did not load: pass the URL the user's browser was sent to (from " +
    "their address bar, with its code and state). Throws when the sign-in is unknown (already completed, replaced " +
    "or never started), expired, refused or the exchange fails. Returns the server, signed in.",
  parameters: Type.Object({
    callbackUrl: Type.String({ description: "The whole URL, or just its query (?code=…&state=…)." }),
  }),
  returns: McpServerSchema,
  async: true,
  tags: ["mcp", "server", "sign in", "oauth", "callback", "code", "complete"],
  execute: async (params, ctx) => {
    const text = params.callbackUrl.trim();
    const query = URL.canParse(text) ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ""));
    return summary(await servers(ctx).finishSignIn({
      state: query.get("state"),
      code: query.get("code"),
      error: query.get("error"),
      errorDescription: query.get("error_description"),
    }));
  },
});

export const mcpToolsFunction = defineFunction({
  name: "mcp.tools",
  description:
    "List an MCP server's tools, with the JSON Schema of their arguments. Connects first if needed; throws when the " +
    `server is disabled, needs sign-in or is down. A server can have hundreds: give a query.\n\n` +
    "  return (await api.mcp.tools(\"vercel\", \"deployment\")).map(tool => tool.name);",
  parameters: Type.Object({
    server: serverParam,
    query: Type.Optional(Type.String({ description: "Only the tools whose name, title or description contains it (any case)." })),
  }),
  returns: Type.Array(McpToolSchema),
  async: true,
  tags: ["mcp", "server", "tools", "list", "search", "schema", "read"],
  execute: async (params, ctx) => {
    const tools = await servers(ctx).find(params.server).listTools({ signal: ctx.signal });
    const query = params.query?.toLowerCase();
    if (!query) return tools;
    return tools.filter(tool => [tool.name, tool.title, tool.description].some(text => text?.toLowerCase().includes(query)));
  },
});

export const mcpCallFunction = defineFunction({
  name: "mcp.call",
  description:
    "Call an MCP server's tool (find it and its arguments with mcp.tools). Returns the tool's result as the server " +
    "sends it; a failure the tool reports is a result with isError, not a throw. Throws when the server is disabled, " +
    "needs sign-in or is down, or rejects the call (an unknown tool, invalid arguments, a timeout).\n\n" +
    "  const result = await api.mcp.call(\"vercel\", \"list_projects\", { teamId: \"team_123\" });\n" +
    "  return result.content[0].text;",
  parameters: Type.Object({
    server: serverParam,
    tool: Type.String({ description: "The tool's name." }),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Its arguments, as its inputSchema describes." })),
    timeoutMs: Type.Optional(Type.Number({ description: "How long to wait for it; 60 seconds by default." })),
  }),
  returns: McpToolResultSchema,
  async: true,
  tags: ["mcp", "server", "tool", "call", "run", "invoke"],
  execute: (params, ctx) =>
    servers(ctx).find(params.server).callTool(params.tool, params.args ?? {}, { signal: ctx.signal, timeoutMs: params.timeoutMs }),
});

export const MCP_FUNCTIONS: ApiFunctionDef[] = [
  mcpListFunction,
  mcpGetFunction,
  mcpAddFunction,
  mcpUpdateFunction,
  mcpRemoveFunction,
  mcpTestFunction,
  mcpSignInFunction,
  mcpFinishSignInFunction,
  mcpSignOutFunction,
  mcpToolsFunction,
  mcpCallFunction,
];
