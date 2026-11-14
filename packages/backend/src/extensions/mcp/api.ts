/**
 * The MCP extension's HTTP API (`reins.http`): its methods, what they take and what they answer. Schemas only,
 * so the frontend part imports its type (`McpApi`) for `reins.http.call`. Handled in `routes.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";
import type { McpTool } from "./connections.js";
import { McpServerInputSchema, McpServerUpdateSchema } from "./input.js";
import { McpRemoteServerSchema, McpSignInSchema, McpStdioServerSchema } from "./scripting.js";
import type { McpServerView, McpSignInStart } from "./servers.js";
import type { McpSessionServersView } from "./repo-servers.js";

const ServerId = Type.Object({ id: Type.Integer({ description: "The server's ID." }) });

// The views keep their TypeScript types (a status is a union of its states): the schemas describe them.
const Timestamps = Type.Object({ createdAt: Type.String(), updatedAt: Type.String() });
const ServerView = Type.Unsafe<McpServerView>(Type.Union([Type.Composite([McpRemoteServerSchema, Timestamps]), Type.Composite([McpStdioServerSchema, Timestamps])]));
const SignInStart = Type.Unsafe<McpSignInStart>(McpSignInSchema);
const Tool = Type.Unsafe<McpTool>(Type.Object({ name: Type.String(), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), inputSchema: Type.Object({}) }));

export const mcpApi = {
  /** Every server's view, in name order (secrets only as `has…`). */
  list: { output: Type.Array(ServerView) },
  /** Adds one (the model refuses an invalid or taken name: 400, 409). */
  create: { input: McpServerInputSchema, output: ServerView },
  /** What is left out is kept, a secret given as null is removed; changing its URL, auth kind or OAuth client
   * signs it out. */
  update: { input: Type.Object({ id: ServerId.properties.id, changes: McpServerUpdateSchema }), output: ServerView },
  /** Removes it and its credentials. */
  remove: { input: ServerId },
  /** Connects afresh and lists its tools: its view, whose status says how it went. */
  test: { input: ServerId, output: ServerView },
  /** Starts an OAuth sign-in: the authorization URL to open in a window, and the callback it returns to (409: not
   * OAuth; 502: discovery or registration failed). The callback page completes it, and an `mcp_server_updated`
   * message says so. */
  signIn: { input: ServerId, output: SignInStart },
  /** Forgets its tokens. */
  signOut: { input: ServerId, output: ServerView },
  /** Its tools (409: disabled or needs sign-in; 502: unreachable). A stdio server's start in `sessionId`'s checkout
   * (a session's MCP servers list); without one, its kept list. */
  tools: { input: Type.Object({ id: ServerId.properties.id, sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }), output: Type.Array(Tool) },

  /** The values the user gives for a repo server's variables (`${VAR}` in its headers or env), by name; null removes one. */
  setVariables: {
    input: Type.Object({
      id: ServerId.properties.id,
      values: Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), Type.Union([Type.String({ maxLength: 16_000 }), Type.Null()]), { maxProperties: 100 }),
    }),
  },
  /** A session's MCP servers list: the repo servers of its own `.mcp.json`, each with its toggle (`allowed`). Null for a
   * session of no project. */
  sessionServers: { input: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 100 }) }), output: Type.Unsafe<McpSessionServersView | null>(Type.Object({})) },
  /** A repo server's toggle in a session's list. On: it may run, and a stdio server's command, as the session read it,
   * is allowed for the project. Off: nothing of it runs for the project. A browser's request only (403 otherwise). */
  allow: {
    input: Type.Object({ id: ServerId.properties.id, allowed: Type.Boolean(), sessionId: Type.String({ minLength: 1, maxLength: 100 }) }),
  },
} satisfies HttpApi;

export type McpApi = typeof mcpApi;
