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
  /** The extension's name, as the server registered it: lowercase letters, digits and hyphens. Its HTTP API
   * is under `/api/extensions/<name>/` and its pages under `/extensions/<name>/`. */
  readonly name: string;
  readonly tools: Tools;
  readonly prompt: Prompt;
  readonly scripting: Scripting;
  readonly http: Http;
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
  /**
   * Its local ID: unique among the extension's tools, and stable, as an agent may call it from an earlier
   * search, a run before a reload or another session. Only `[a-zA-Z0-9_-]`, at most `Tools.maxLocalIdLength`
   * characters. The host shows agents the final ID, `<extension>__<local ID>` (at most 64 characters, so
   * that it can also be a model's tool name), and gives the extension back the local ID at a call. A tool
   * whose ID breaks these rules is left out of searches and reported as the extension's error: the host
   * never changes an ID.
   */
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
 * Where an extension's tools come from: one for each extension. Providers are asked at each search and
 * each call: the core keeps no list of their tools and no map of IDs. A call goes to the provider of the
 * extension its ID names.
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
   * Runs the tool of local ID `localId` (the agent's ID without the extension's prefix; `[a-zA-Z0-9_-]+`).
   * An ID that is none of its tools throws, as does a tool that cannot be run: the throw reaches the agent's
   * script. `timeoutMs` is the agent's, when it gave one.
   */
  call(localId: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs?: number }): Promise<ToolResult>;
}

export interface Tools {
  /** Registers the extension's tool provider. An extension has one at a time: registering a second while it
   * has one throws. */
  register(provider: ToolProvider): Disposer;
  /** How long a local ID may be: 64 less the extension's prefix (`<name>__`). */
  readonly maxLocalIdLength: number;
  /** The tools that match `query`, best first, by the rules the core's searches use: each word is a
   * substring of the ID, name, title, argument names or description (a plural word also finds its
   * singular); those that match every word, else, for several words, those that match the most. A query
   * that is a tool's ID or name (any case) puts that tool first. All of them, in order, for an empty query. */
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
// HTTP: the extension's API and pages
// ---------------------------------------------------------------------------

/**
 * A method of the extension's HTTP API: what it takes and what it answers, as JSON Schema. A schema with a
 * `static` type (a TypeBox schema has one) types the handler and the frontend's `reins.http.call`; any other
 * gives `unknown`. A method without `output` answers nothing.
 */
export interface HttpMethod {
  readonly input?: JsonSchema;
  readonly output?: JsonSchema;
}

/**
 * The extension's HTTP API: its methods by name (`[a-zA-Z][a-zA-Z0-9_]*`). Keep it in a module of its own,
 * of schemas only, so that the extension's frontend part can import its type (`typeof api`) for
 * `ReinsSdk<typeof api>`.
 */
export type HttpApi = Readonly<Record<string, HttpMethod>>;

/** The type a schema gives: its `static` type, else `unknown`. */
export type SchemaType<S> = S extends { readonly static: infer T } ? T : unknown;

/** What a method's handler is given. */
export interface HttpCall<I> {
  /** The request's JSON body, which its `input` schema accepted; undefined for a method without `input`. */
  input: I;
  /** Aborts when the browser goes away. */
  signal: AbortSignal;
  /** The origin the browser used to reach Reins (behind a proxy, from `X-Forwarded-*`), for URLs the
   * browser is sent to; null when the request's host is not usable. */
  origin: string | null;
}

/** A handler for each method of `A`, which returns the method's output (nothing for one without `output`). */
export type HttpHandlers<A extends HttpApi> = {
  [K in keyof A]: (call: HttpCall<A[K] extends { readonly input: infer S } ? SchemaType<S> : undefined>)
    => HttpOutput<A[K]> | Promise<HttpOutput<A[K]>>;
};

type HttpOutput<M> = M extends { readonly output: infer S } ? SchemaType<S> : void;

export interface PageRequest {
  req: Request;
  url: URL;
  /** The path's named parameters (`/items/:id`), decoded. */
  params: Record<string, string>;
  /** As `HttpCall.origin`. */
  origin: string | null;
}

/** A thrown error is logged and answered 500 with its message. */
export type PageHandler = (request: PageRequest) => Response | Promise<Response>;

export interface Http {
  /**
   * Handles the methods of `api`. Each is `POST /api/extensions/<name>/<method>` with its input as the JSON
   * body: the host checks it against `input` (400 `{ error }` naming the first wrong field, and the handler
   * is not called), then answers the handler's return value as JSON, or 204 for a method without `output`.
   * A thrown Error with a numeric `status` (400 to 599) is answered with it and `{ error: message }`; any
   * other throw is logged and answered 500 with its message. A method name the extension already handles
   * throws. The frontend calls them with `reins.http.call`.
   */
  handle<A extends HttpApi>(api: A, handlers: HttpHandlers<A>): Disposer;
  /**
   * A page the browser goes to itself (an OAuth callback, a link), not the frontend's code: `GET
   * /extensions/<name><path>`, a URL pattern (`/items/:id`). It answers what it likes (HTML, a redirect).
   * A path no page matches is answered 404.
   */
  page(path: string, handler: PageHandler): Disposer;
  /** The path a page has from the server's root: `/extensions/<name><path>`. */
  pagePath(path: string): string;
}
