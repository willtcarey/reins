/**
 * `api.mcp`, the MCP extension's scripting functions (`reins.scripting`): managing the remote MCP servers of
 * Settings → MCP servers (docs/dev/mcp-servers.md). Their tools are `api.tools`' (`tools.ts`).
 */

import { Type, type Static, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import type { ScriptContext, ScriptFunction, ScriptType } from "@reins/sdk/server";
import type { McpServers, McpServerView } from "./servers.js";
import { McpServerInputSchema, McpServerUpdateSchema } from "./input.js";
import { McpAuthKindSchema, McpTransportKindSchema } from "./store.js";

/** A function whose `execute` is typed by its schemas. */
function scriptFunction<P extends TObject<TProperties>, R extends TSchema>(def: {
  name: string;
  description: string;
  parameters: P;
  returns: R;
  async?: boolean;
  tags: string[];
  execute: (params: Static<P>, context: ScriptContext) => Static<R> | Promise<Static<R>>;
}): ScriptFunction {
  return def;
}

const SIGN_IN = "An OAuth server is signed in to with mcp.signIn (or by the user, under Settings → MCP servers).";

export const McpSignInSchema = Type.Object({
  authorizationUrl: Type.String({ description: "The page to send the user to, to sign in and approve Reins." }),
  callbackUrl: Type.String({ description: "Where their browser comes back with the code once they approve." }),
});

export const McpServerStatusSchema = Type.Object({
  state: Type.Union([Type.Literal("ready"), Type.Literal("needs_sign_in"), Type.Literal("error"), Type.Literal("disabled")]),
  message: Type.Optional(Type.String({ description: "When state is error: why its last attempt or request failed." })),
}, { description: `Whether agents can use the server, e.g. { state: "ready" } or { state: "error", message }. ${SIGN_IN}` });

export const McpServerSchema = Type.Object({
  id: Type.Number(),
  name: Type.String({ description: "Unique; lowercase letters, digits and hyphens. Its tools' IDs are mcp__<name>__<tool>." }),
  instructions: Type.String({ description: "Given to agents in their system prompt under its name." }),
  url: Type.String({ description: "Its MCP endpoint." }),
  transport: Type.Union(McpTransportKindSchema.anyOf, { description: "\"http\" (streamable HTTP) or \"sse\" (legacy HTTP+SSE)." }),
  authKind: McpAuthKindSchema,
  headerName: Type.Union([Type.String(), Type.Null()], { description: "Header auth: the header sent with every request." }),
  hasHeaderValue: Type.Boolean({ description: "Header auth: whether its value is set (it is never returned)." }),
  oauthClientId: Type.Union([Type.String(), Type.Null()], { description: "OAuth: a pre-registered client; null registers Reins dynamically." }),
  hasClientSecret: Type.Boolean({ description: "OAuth: whether the pre-registered client's secret is set (it is never returned)." }),
  oauthScope: Type.Union([Type.String(), Type.Null()], { description: "OAuth: the scope sign-ins ask for; null for the server's own." }),
  enabled: Type.Boolean(),
  signedIn: Type.Boolean({ description: "OAuth: whether Reins holds tokens for it." }),
  status: McpServerStatusSchema,
});

export const McpServerTestSchema = Type.Object({
  server: McpServerSchema,
  toolCount: Type.Union([Type.Number(), Type.Null()], { description: "How many tools it listed; null when the attempt failed." }),
});

const serverParam = Type.Union([Type.String(), Type.Number()], { description: "Its name or ID." });

function summary(server: McpServerView) {
  return {
    id: server.id,
    name: server.name,
    instructions: server.instructions,
    url: server.url,
    transport: server.transport,
    authKind: server.authKind,
    headerName: server.headerName,
    hasHeaderValue: server.hasHeaderValue,
    oauthClientId: server.oauthClientId,
    hasClientSecret: server.hasClientSecret,
    oauthScope: server.oauthScope,
    enabled: server.enabled,
    signedIn: server.signedIn,
    status: server.status,
  };
}

/** The functions over `servers`; `callbackPath` is the OAuth callback page's path from the server's root. */
export function mcpScripting(servers: McpServers, callbackPath: string): { functions: ScriptFunction[]; types: ScriptType[] } {

  const mcpListFunction = scriptFunction({
    name: "mcp.list",
    description: "List the remote MCP servers set up in Reins (Settings → MCP servers), in name order, with each one's status. Secrets are only said to be set.",
    parameters: Type.Object({}),
    returns: Type.Array(McpServerSchema),
    tags: ["mcp", "servers", "list", "status", "read"],
    execute: () => servers.list().map(summary),
  });

  const mcpGetFunction = scriptFunction({
    name: "mcp.get",
    description: "Get one MCP server by name or ID. Throws for an unknown one, naming those there are.",
    parameters: Type.Object({ server: serverParam }),
    returns: McpServerSchema,
    tags: ["mcp", "server", "get", "status", "read"],
    execute: (params) => summary(servers.find(params.server).view()),
  });

  const mcpAddFunction = scriptFunction({
    name: "mcp.add",
    description:
      "Add a remote MCP server (HTTP; stdio is not supported). transport is \"http\" (streamable HTTP, the default) or " +
      "\"sse\" for a legacy HTTP+SSE server. Header auth needs headerName and headerValue. " +
      `It is not connected until used: mcp.test connects and reports. ${SIGN_IN}\n\n` +
      "  await api.mcp.add({ name: \"executor\", url: \"https://executor.example.com/mcp\", authKind: \"oauth\" });\n" +
      "  return await api.mcp.test(\"executor\");",
    parameters: Type.Object({ server: McpServerInputSchema }),
    returns: McpServerSchema,
    tags: ["mcp", "server", "add", "create", "write", "oauth", "header", "api key"],
    execute: (params) => summary(servers.create(params.server)),
  });

  const mcpUpdateFunction = scriptFunction({
    name: "mcp.update",
    description:
      "Change an MCP server: what is left out is kept; a secret given as null is removed. Changing its url, authKind or " +
      "oauthClientId signs it out; changing its transport only reconnects. `enabled: false` disables it.",
    parameters: Type.Object({ server: serverParam, changes: McpServerUpdateSchema }),
    returns: McpServerSchema,
    async: true,
    tags: ["mcp", "server", "update", "edit", "enable", "disable", "write"],
    execute: async (params) => summary(await servers.find(params.server).update(params.changes)),
  });

  const mcpRemoveFunction = scriptFunction({
    name: "mcp.remove",
    description: "Remove an MCP server and its credentials for good.",
    parameters: Type.Object({ server: serverParam }),
    returns: Type.Void(),
    async: true,
    tags: ["mcp", "server", "remove", "delete", "write"],
    execute: async (params) => { await servers.find(params.server).remove(); },
  });

  const mcpTestFunction = scriptFunction({
    name: "mcp.test",
    description:
      "Connect to an MCP server afresh and list its tools: the server after the attempt (status.state ready, or error " +
      "with status.message saying why, or needs_sign_in) and how many tools it listed (null when it failed).",
    parameters: Type.Object({ server: serverParam }),
    returns: McpServerTestSchema,
    async: true,
    tags: ["mcp", "server", "test", "connect", "status", "check"],
    execute: async (params, context) => {
      const { server, toolCount } = await servers.find(params.server).test(context.signal);
      return { server: summary(server), toolCount };
    },
  });

  const mcpSignOutFunction = scriptFunction({
    name: "mcp.signOut",
    description: "Forget an OAuth MCP server's tokens; it then needs sign-in.",
    parameters: Type.Object({ server: serverParam }),
    returns: McpServerSchema,
    async: true,
    tags: ["mcp", "server", "sign out", "logout", "oauth", "tokens", "write"],
    execute: async (params) => summary(await servers.find(params.server).signOut()),
  });

  const mcpSignInFunction = scriptFunction({
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
        description: `Reins' address as the user's browser opens it, e.g. https://reins.example.com: the callback is its ${callbackPath}. ` +
          "By default the one of the latest completed sign-in, else http://localhost:<Reins' port>. A server's pre-registered " +
          "client accepts only the callback registered with it.",
      })),
    }),
    returns: McpSignInSchema,
    async: true,
    tags: ["mcp", "server", "sign in", "login", "oauth", "authorize", "url"],
    execute: async (params) => {
      const server = servers.find(params.server);
      if (params.callbackOrigin === undefined) return server.startSignIn();
      let origin: string;
      try { origin = new URL(params.callbackOrigin).origin; } catch { throw new Error(`Not a URL: ${params.callbackOrigin}`); }
      return server.startSignIn(`${origin}${callbackPath}`);
    },
  });

  const mcpFinishSignInFunction = scriptFunction({
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
    execute: async (params) => {
      const text = params.callbackUrl.trim();
      const query = URL.canParse(text) ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ""));
      return summary(await servers.finishSignIn({
        state: query.get("state"),
        code: query.get("code"),
        error: query.get("error"),
        errorDescription: query.get("error_description"),
      }));
    },
  });

  const functions: ScriptFunction[] = [
    mcpListFunction,
    mcpGetFunction,
    mcpAddFunction,
    mcpUpdateFunction,
    mcpRemoveFunction,
    mcpTestFunction,
    mcpSignInFunction,
    mcpFinishSignInFunction,
    mcpSignOutFunction,
  ];
  return {
    functions,
    types: [
      { name: "McpServer", schema: McpServerSchema },
      { name: "McpServerStatus", schema: McpServerStatusSchema },
      { name: "McpSignIn", schema: McpSignInSchema },
      { name: "McpServerTest", schema: McpServerTestSchema },
    ],
  };
}
