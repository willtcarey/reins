/**
 * `reins.mcp`, the MCP extension's scripting functions (`reins.scripting`): managing the remote MCP servers of
 * Settings → MCP (docs/dev/mcp-servers.md). Their tools are `reins.tools`' (`tools.ts`).
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { ScriptContext, ScriptMethod, ScriptNamespace, ScriptParam } from "@reins/sdk/server";
import type { McpServers, McpServerView } from "./servers.js";
import { McpServerInputSchema, McpServerUpdateSchema } from "./input.js";
import { McpAuthKindSchema, McpTransportKindSchema } from "./store.js";

/** A method whose `run` is typed by its schemas. */
const scriptMethod = <const P extends readonly ScriptParam[], R extends TSchema>(method: ScriptMethod<ScriptContext, P, R, Static<R>>) => method;

const SIGN_IN = "An OAuth server is signed in to with mcp.signIn (or by the user, under Settings → MCP).";

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

const serverParam = { name: "server", schema: Type.Union([Type.String(), Type.Number()], { description: "Its name or ID." }) } as const;

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
export function mcpScripting(servers: McpServers, callbackPath: string): ScriptNamespace {

  const list = scriptMethod({
    description: "List the remote MCP servers set up in Reins (Settings → MCP), in name order, with each one's status. Secrets are only said to be set.",
    params: [],
    returns: Type.Array(McpServerSchema),
    tags: ["mcp", "servers", "list", "status", "read"],
    run: async () => (await servers.list()).map(summary),
  });

  const get = scriptMethod({
    description: "Get one MCP server by name or ID. Throws for an unknown one, naming those there are.",
    params: [serverParam],
    returns: McpServerSchema,
    tags: ["mcp", "server", "get", "status", "read"],
    run: async (_context, server) => summary(await servers.find(server).view()),
  });

  const add = scriptMethod({
    description:
      "Add a remote MCP server (HTTP; stdio is not supported). transport is \"http\" (streamable HTTP, the default) or " +
      "\"sse\" for a legacy HTTP+SSE server. Header auth needs headerName and headerValue. " +
      `It is not connected until used: mcp.test connects and reports. ${SIGN_IN}\n\n` +
      "  await reins.mcp.add({ name: \"executor\", url: \"https://executor.example.com/mcp\", authKind: \"oauth\" });\n" +
      "  return await reins.mcp.test(\"executor\");",
    params: [{ name: "server", schema: McpServerInputSchema }],
    returns: McpServerSchema,
    tags: ["mcp", "server", "add", "create", "write", "oauth", "header", "api key"],
    run: async (_context, server) => summary(await servers.create(server)),
  });

  const update = scriptMethod({
    description:
      "Change an MCP server: what is left out is kept; a secret given as null is removed. Changing its url, authKind or " +
      "oauthClientId signs it out; changing its transport only reconnects. `enabled: false` disables it.",
    params: [serverParam, { name: "changes", schema: McpServerUpdateSchema }],
    returns: McpServerSchema,
    tags: ["mcp", "server", "update", "edit", "enable", "disable", "write"],
    run: async (_context, server, changes) => summary(await servers.find(server).update(changes)),
  });

  const remove = scriptMethod({
    description: "Remove an MCP server and its credentials for good.",
    params: [serverParam],
    returns: Type.Void(),
    tags: ["mcp", "server", "remove", "delete", "write"],
    run: async (_context, server) => { await servers.find(server).remove(); },
  });

  const test = scriptMethod({
    description:
      "Connect to an MCP server afresh and list its tools: the server after the attempt (status.state ready, or error " +
      "with status.message saying why, or needs_sign_in) and how many tools it listed (null when it failed).",
    params: [serverParam],
    returns: McpServerTestSchema,
    tags: ["mcp", "server", "test", "connect", "status", "check"],
    run: async (context, name) => {
      const { server, toolCount } = await servers.find(name).test(context.signal);
      return { server: summary(server), toolCount };
    },
  });

  const signOut = scriptMethod({
    description: "Forget an OAuth MCP server's tokens; it then needs sign-in.",
    params: [serverParam],
    returns: McpServerSchema,
    tags: ["mcp", "server", "sign out", "logout", "oauth", "tokens", "write"],
    run: async (_context, server) => summary(await servers.find(server).signOut()),
  });

  const signIn = scriptMethod({
    description:
      "Start an OAuth sign-in to an MCP server: give the user `authorizationUrl` to open. Once they approve, their " +
      "browser goes to `callbackUrl`. If it reaches Reins there, the sign-in completes by itself (mcp.get shows " +
      "signedIn). If that page does not load (Reins is not at that address for their browser), ask them for the URL " +
      "in their address bar and pass it to mcp.finishSignIn. The sign-in must end within 15 minutes; starting another " +
      "replaces it.\n\n" +
      "  const { authorizationUrl } = await reins.mcp.signIn(\"executor\");\n" +
      "  return authorizationUrl; // for the user to open",
    params: [
      serverParam,
      {
        name: "callbackOrigin",
        schema: Type.String({
          description: `Reins' address as the user's browser opens it, e.g. https://reins.example.com: the callback is its ${callbackPath}. ` +
            "By default the one of the latest completed sign-in, else http://localhost:<Reins' port>. A server's pre-registered " +
            "client accepts only the callback registered with it.",
        }),
        optional: true,
      },
    ],
    returns: McpSignInSchema,
    tags: ["mcp", "server", "sign in", "login", "oauth", "authorize", "url"],
    run: async (_context, name, callbackOrigin) => {
      const server = servers.find(name);
      if (callbackOrigin === undefined) return server.startSignIn();
      let origin: string;
      try { origin = new URL(callbackOrigin).origin; } catch { throw new Error(`Not a URL: ${callbackOrigin}`); }
      return server.startSignIn(`${origin}${callbackPath}`);
    },
  });

  const finishSignIn = scriptMethod({
    description:
      "Complete an mcp.signIn whose callback page did not load: pass the URL the user's browser was sent to (from " +
      "their address bar, with its code and state). Throws when the sign-in is unknown (already completed, replaced " +
      "or never started), expired, refused or the exchange fails. Returns the server, signed in.",
    params: [{ name: "callbackUrl", schema: Type.String({ description: "The whole URL, or just its query (?code=…&state=…)." }) }],
    returns: McpServerSchema,
    tags: ["mcp", "server", "sign in", "oauth", "callback", "code", "complete"],
    run: async (_context, callbackUrl) => {
      const text = callbackUrl.trim();
      const query = URL.canParse(text) ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ""));
      return summary(await servers.finishSignIn({
        state: query.get("state"),
        code: query.get("code"),
        error: query.get("error"),
        errorDescription: query.get("error_description"),
      }));
    },
  });

  return {
    namespace: "mcp",
    methods: { list, get, add, update, remove, test, signIn, finishSignIn, signOut },
    types: { McpServer: McpServerSchema, McpServerStatus: McpServerStatusSchema, McpSignIn: McpSignInSchema, McpServerTest: McpServerTestSchema },
  };
}
