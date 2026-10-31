/**
 * `@reins/sdk/server`: what a backend extension gets from the server (docs/dev/server-sdk.md). An extension's
 * register function takes a `ServerSdk` and returns its disposer, as a frontend extension does with
 * `@reins/sdk` (ADR-030). The server calls it each time it builds an app, and the disposer when that app
 * stops, so a reload registers the extension again on its new code.
 *
 * Types only, and it imports only its own modules and the type of the database (`bun:sqlite`): an extension
 * uses only what its register function is given. Each member's comment states its behavior; keep them accurate when the host changes
 * (`extensions/host.ts`).
 */

import type { Database } from "bun:sqlite";

/** Undoes a registration, or stops what a register function started. The host awaits a promise it
 * returns (closing connections) before the next app starts using what the extension holds. */
export type Disposer = () => void | Promise<void>;

/** A backend extension's entry point. It registers what it contributes and starts what it needs, and
 * returns the disposer that stops it. What it registered is removed when the app stops even if the
 * disposer forgets it. A register function that throws is logged, and what it registered is removed. */
export type RegisterExtension = (reins: ServerSdk) => Disposer;

export interface ServerSdk {
  /** The extension's name, as the server registered it: lowercase letters, digits and hyphens. Its routes
   * are under `/api/extensions/<name>/` and `/extensions/<name>/`. */
  readonly name: string;
  readonly tools: Tools;
  readonly prompt: Prompt;
  readonly scripting: Scripting;
  readonly routes: Routes;
  /**
   * The server's main database, for built-in extensions: their tables are created by the core's migrations.
   * Read it at each use, not once: it is the process's connection. An installable extension will get a
   * database of its own instead (docs/plans/backend-extensions.md *Not in this plan*).
   */
  readonly db: Database;
  readonly logger: Logger;
  readonly secrets: Secrets;
  /** Sends `message` to every browser connected now, as `{ type: "extension", extension: <name>, message }`:
   * the extension's frontend part tells its messages apart by `message`. It must be JSON. Nothing is kept
   * for a browser that connects later. */
  broadcast(message: object): void;
}

/**
 * Encryption of secrets at rest with the server's key (AES-256-GCM), the one the core keeps its own
 * credentials with. The extension stores what `encrypt` gives where it likes (its own table), and never
 * the plaintext. Synchronous: it does no I/O.
 */
export interface Secrets {
  encrypt(plaintext: string): string;
  /** Throws for text another key encrypted, or that was changed. */
  decrypt(ciphertext: string): string;
}

/** The server's log, by level (`REINS_LOG_LEVEL`). */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** A JSON Schema object, as JSON Schema defines it (a TypeBox schema is one). */
export type JsonSchema = object;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** What a tool says about itself (MCP's annotations): hints, not guarantees. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool an agent can call through `api.tools.call(id, args)`. */
export interface Tool {
  /** Unique among every provider's tools, and stable: an agent may call it from an earlier search, a run
   * before a reload or another session. It belongs to the extension: the core adds no prefix and does not
   * parse it. Use `[a-zA-Z0-9_-]`, at most 64 characters, so that it can also be a model's tool name. */
  id: string;
  /** Its name where it comes from (an MCP server's tool name). */
  name: string;
  title?: string;
  description?: string;
  /** Its arguments: an object schema. */
  inputSchema: JsonSchema;
  /** The schema of its result's `structuredContent`, when it has one. */
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

/** A tool's result. A failure that the tool reports is a result with `isError`, not a throw, so that its
 * content reaches the agent. */
export interface ToolResult {
  /** Content blocks, e.g. `{ type: "text", text }`. */
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** What an agent gives `api.tools.search` to narrow it, given to every provider as it is. Each provider decides
 * what its keys mean, and what it does with keys it does not know: the core makes no rule. A provider tells
 * agents its filters in its prompt section. */
export type ToolFilters = Readonly<Record<string, unknown>>;

/**
 * Where tools come from. Providers are asked at each search and each call: the core keeps no list of their
 * tools and no map of IDs.
 */
export interface ToolProvider {
  /** Shown above its tools in a search's answer, e.g. "MCP servers". */
  readonly title: string;
  /**
   * Its tools that match `query` and `filters`, best first (`Tools.match` ranks as the core does). An empty
   * query asks for every tool the filters let through. Runs at the same time as the other providers'
   * searches; `signal` aborts when the agent's script ends. A throw is shown to the agent in place of this
   * provider's tools, and does not stop the other providers.
   */
  search(query: string, options: { filters: ToolFilters; signal: AbortSignal }): Promise<Tool[]>;
  /**
   * Runs tool `id`, or answers null ("not mine") without running anything when the ID is not one of its
   * tools. The core asks the providers one after another, in the order of registration, and the first that
   * claims the ID runs it: a duplicate ID is the extension's error. A throw reaches the agent's script.
   * `timeoutMs` is the agent's, when it gave one.
   */
  call(id: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs?: number }): Promise<ToolResult | null>;
}

export interface Tools {
  /** Adds a tool provider after those registered before it. */
  register(provider: ToolProvider): Disposer;
  /** The tools that match `query`, best first, by the rules the core's searches use: each word is a
   * substring of the ID, name, title, argument names or description (a plural word also finds its
   * singular); those that match every word, else, for several words, those that match the most. All of
   * them, in order, for an empty query. */
  match(query: string, tools: readonly Tool[]): Tool[];
}

// ---------------------------------------------------------------------------
// The system prompt
// ---------------------------------------------------------------------------

export interface PromptContext {
  session: { id: string; projectId: number; taskId: number | null };
  task: { id: number; title: string; description: string | null } | null;
  /** The tools the session's model is offered, by name (`execute`, `search`, `read`, …); null: every tool. */
  tools: readonly string[] | null;
}

/**
 * A section of an agent session's system prompt, or null for none. Called each time a session's runtime
 * opens, so a change reaches a session the next time it opens. The sections follow the Reins section, in
 * the order of registration. Only the Reins agent's sessions get them (not utility sessions, such as task
 * generation). A throw is logged, and the session opens without the section.
 */
export type PromptContribution = (context: PromptContext) => string | null | Promise<string | null>;

export interface Prompt {
  register(contribution: PromptContribution): Disposer;
}

// ---------------------------------------------------------------------------
// Scripting: an extension's own `api.<namespace>` in `execute`
// ---------------------------------------------------------------------------

/** What a scripting function runs for: the agent's session, and its script's signal. */
export interface ScriptContext {
  sessionId: string;
  projectId: number;
  taskId: number | null;
  signal?: AbortSignal;
}

/**
 * A function of `api` in `execute`, which `search` documents. A script calls it with positional
 * arguments, in the order of the parameters' properties: `api.mcp.get(server)` for
 * `{ server: … }`. Its result reaches the script as it is; a throw reaches it as an error.
 */
export interface ScriptFunction {
  /** `<namespace>.<method>`, e.g. `mcp.list`. */
  name: string;
  description: string;
  /** An object schema: its properties are the arguments, in order. */
  parameters: JsonSchema;
  returns: JsonSchema;
  /** It returns a promise. */
  async?: boolean;
  /** Lowercase words `search` also matches. */
  tags: string[];
  execute(params: Record<string, unknown>, context: ScriptContext): unknown;
}

/** A schema that `search` shows by its name where a function's parameters or result use it (by identity). */
export interface ScriptType { name: string; schema: JsonSchema }

export interface Scripting {
  /** Adds functions to `api`. Their namespaces must not be the core's or another registration's: that
   * throws. */
  register(functions: { functions: readonly ScriptFunction[]; types?: readonly ScriptType[] }): Disposer;
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

export interface RouteRequest {
  req: Request;
  url: URL;
  /** The path's named parameters (`/servers/:id`), decoded. */
  params: Record<string, string>;
  /** The origin the browser used to reach Reins (behind a proxy, from `X-Forwarded-*`), for URLs the
   * browser is sent to; null when the request's host is not usable. */
  origin: string | null;
}

/** A thrown error is logged and answered 500 with its message. */
export type RouteHandler = (request: RouteRequest) => Response | Promise<Response>;

/** Routes under one prefix. A path is a URL pattern (`/servers/:id`) after the prefix. */
export interface RouteGroup {
  get(path: string, handler: RouteHandler): Disposer;
  post(path: string, handler: RouteHandler): Disposer;
  put(path: string, handler: RouteHandler): Disposer;
  patch(path: string, handler: RouteHandler): Disposer;
  delete(path: string, handler: RouteHandler): Disposer;
}

export interface Routes {
  /** The extension's HTTP API, under `/api/extensions/<name>`. A path no route matches is answered 404. */
  readonly api: RouteGroup;
  /** Pages for the browser (an OAuth callback), under `/extensions/<name>`. */
  readonly pages: RouteGroup;
  /** The path a page route has from the server's root: `/extensions/<name><path>`. */
  pagePath(path: string): string;
}
