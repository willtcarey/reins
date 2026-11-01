/**
 * The MCP extension's HTTP API (`reins.http`): its methods, what they take and what they answer. Schemas only,
 * so the frontend part imports its type (`McpApi`) for `reins.http.call`. Handled in `routes.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";
import type { McpTool } from "./connections.js";
import { McpServerInputSchema, McpServerUpdateSchema } from "./input.js";
import { McpServerSchema, McpSignInSchema } from "./scripting.js";
import type { McpServerView, McpSignInStart } from "./servers.js";

const ServerId = Type.Object({ id: Type.Integer({ description: "The server's ID." }) });

// The views keep their TypeScript types (a status is a union of its states): the schemas describe them.
const ServerView = Type.Unsafe<McpServerView>(Type.Composite([McpServerSchema, Type.Object({ createdAt: Type.String(), updatedAt: Type.String() })]));
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
  /** Its tools (409: disabled or needs sign-in; 502: unreachable). */
  tools: { input: ServerId, output: Type.Array(Tool) },
} satisfies HttpApi;

export type McpApi = typeof mcpApi;
