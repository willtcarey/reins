/**
 * `@reins/sdk/server`: what a backend extension gets from the server (docs/dev/server-sdk.md). An extension's
 * register function takes a `ServerSdk` and returns its disposer, as a frontend extension does with
 * `@reins/sdk` (ADR-030). The server calls it each time it builds an app, and the disposer when that app
 * stops, so a reload registers the extension again on its new code.
 *
 * Types only, and it imports only its own modules and the type of the database (`bun:sqlite`'s `Database`, which its own `Database` extends): an extension
 * uses only what its register function is given. Each member's comment states its behavior; keep them accurate when the host changes
 * (`extensions/host.ts`).
 */

import type { Database as BunDatabase } from "bun:sqlite";

/**
 * An extension's SQLite database (`ServerSdk.db`, a migration's `up`): for now, everything Bun's `bun:sqlite`
 * `Database` has (`query`, `exec`, `transaction`, …), so an extension runs in the Bun server process.
 * Extensions name it only from here, so that Reins can give it its own members later without them
 * importing Bun's.
 */
export interface Database extends BunDatabase {}

/** Undoes a registration, or stops what a register function started. The host awaits a promise it
 * returns (closing connections) before the next app starts using what the extension holds. */
export type Disposer = () => void | Promise<void>;

/** A backend extension's entry point. It registers what it contributes and starts what it needs, and
 * returns the disposer that stops it. What it registered is removed when the app stops even if the
 * disposer forgets it. A register function that throws is logged, and what it registered is removed. */
export type RegisterExtension = (reins: ServerSdk) => Disposer;

/** A backend extension: its database's migrations, and its register function. */
export interface ServerExtension {
  /**
   * Its database's schema changes, oldest first. Before each registration (each app: a dev reload too), the
   * host applies, in this order, those its database has not recorded, each in a transaction with its record
   * (in the host's table `reins_migrations`). One that throws is rolled back and reported, and the
   * extension does not load in that app: the migrations before it stay applied, and the next app tries it
   * again. Never change or remove one that has shipped: add a new one.
   */
  readonly migrations?: readonly Migration[];
  readonly register: RegisterExtension;
}

export interface Migration {
  /** Unique among the extension's migrations and stable: it is what the host records (e.g. `001_notes`). */
  readonly id: string;
  /** Changes the extension's database (`ServerSdk.db`), synchronously: the host's transaction wraps it. */
  up(db: Database): void;
}

export interface ServerSdk {
  /** The extension's name, as the server registered it: lowercase letters, digits and hyphens. Its HTTP API
   * is under `/api/extensions/<name>/` and its pages under `/extensions/<name>/`. */
  readonly name: string;
  readonly tools: Tools;
  readonly prompt: Prompt;
  readonly scripting: Scripting;
  readonly http: Http;
  readonly services: Services;
  /** Sessions: start them, message them, read them, and hear when the runs of those it started end. */
  readonly sessions: Sessions;
  /**
   * The extension's own directory, `<data dir>/extensions/<name>/` (absolute), which the host creates before
   * the extension registers and never deletes. The extension writes its files only here.
   */
  readonly dataDir: string;
  /**
   * The extension's own SQLite database, `db.sqlite` in `dataDir` (WAL, foreign keys on), with its
   * migrations applied (`ServerExtension.migrations`). The extension has no access to the server's main
   * database. The process opens it once and keeps it across apps (a dev reload): do not close it.
   */
  readonly db: Database;
  readonly logger: Logger;
  /** Keys are 1 to 256 characters: another key rejects. */
  readonly secrets: SecretStorage;
  /** Sends `message` to every browser connected now, as `{ type: "extension", extension: <name>, message }`:
   * the extension's frontend part tells its messages apart by `message`. It must be JSON. Nothing is kept
   * for a browser that connects later. */
  broadcast(message: object): void;
}

/**
 * The extension's secrets (tokens, API keys), by key: a store the host keeps for each extension, as VS Code's
 * `SecretStorage` is. An extension sees only its own keys. The host keeps each value encrypted with the
 * server's key (AES-256-GCM, the one the core keeps its own credentials with) in the server's main database,
 * not in the extension's: the extension never handles the encryption or the ciphertext. Values stay when the
 * extension is no longer registered, as its directory does.
 *
 * Async, so that the host can keep them elsewhere later (an OS keychain). For the same reason a write is not
 * part of a transaction of the extension's database: a write to both can be half done, and the extension
 * must order them so that this does no harm (e.g. delete a record's secrets when it deletes the record).
 */
export interface SecretStorage {
  /** The value of `key`, or undefined when it has none. Rejects for a value the host cannot decrypt (the
   * server's key changed). */
  get(key: string): Promise<string | undefined>;
  /** Sets `key` to `value`, replacing its value. */
  set(key: string, value: string): Promise<void>;
  /** Removes `key`; nothing for a key it does not have. */
  delete(key: string): Promise<void>;
  /** The keys it has (not their values), in order; only those that start with `prefix` when given. */
  keys(prefix?: string): Promise<string[]>;
}

/** The server's log, by level (`REINS_LOG_LEVEL`). */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Services: the extension's long-running work, in the host's lifecycle
// ---------------------------------------------------------------------------

/**
 * Long-running work of the extension (a timer, polling, a queue), which the host starts and stops: the
 * extension never keeps its own `setInterval` across reloads. What it does inside `start` is its own.
 *
 * Give `signal` to everything that waits or listens (timers from `timers/promises`, `fetch`,
 * `addEventListener`), so the abort ends it all and no `stop` is needed. For polling, wait between ticks, as
 * a loop: `while (!signal.aborted) { await poll(signal); await setTimeout(ms, undefined, { signal }); }`,
 * started with `void loop().catch(fail)`. A slow tick then delays the next one, never overlaps it, and a
 * throw is a crash (the rejection at the abort is not: `fail` after it is nothing).
 */
export interface Service {
  /** Unique among the extension's services: lowercase letters, digits and hyphens. */
  readonly name: string;
  /**
   * Starts one instance. The host calls it once the extension has registered (its migrations applied, its
   * register function returned without a throw), or at once for a service registered later, and again after
   * a crash or a reload. There is never more than one instance of a service in the server process, unless a
   * `stop` did not end in time (see `ServiceInstance.stop`). A throw or a rejection is a crash.
   */
  start(context: ServiceContext): ServiceInstance | void | Promise<ServiceInstance | void>;
}

export interface ServiceContext {
  /** Aborts when the host stops this instance (before its `stop` is called), after a crash too. The one way
   * to end what the instance started: give it to each timer, request and listener. */
  readonly signal: AbortSignal;
  /** The extension's logger, its lines prefixed with the extension's and the service's names. */
  readonly logger: Logger;
  /**
   * Reports a crash after `start` returned (a loop that cannot go on): the host stops this instance (aborts
   * `signal`, calls `stop`) and starts a new one after a backoff, 1 s doubling to 5 min, back to 1 s once an
   * instance has run for a minute. Only an instance's first call counts; a call after it was stopped is
   * nothing.
   */
  fail(error: unknown): void;
}

export interface ServiceInstance {
  /**
   * Ends the instance's work: called once, after `signal` aborted, when the registration is disposed, the
   * extension is disposed (a reload, the server stopping) or the instance crashed. The host waits for it at
   * most 5 s, then logs it and goes on: a reload or a shutdown is not held up, and the service is `failed`
   * (not started again in this app, as the old instance may still run). A throw is logged.
   */
  stop?(): void | Promise<void>;
}

export interface Services {
  /** Registers a service; a name the extension already has throws. The disposer stops it (as `stop` says)
   * and resolves once it has stopped. Each service's state is in the host's report (Settings → Extensions). */
  register(service: Service): Disposer;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A location sessions work in: a node and an absolute path on it. */
export interface Location {
  readonly nodeId: string;
  readonly path: string;
}

/** A session as the server has it now. */
export interface SessionInfo {
  readonly id: string;
  /** Where it works: its source (a location, with its ID). */
  readonly source: Location & { readonly id: number };
  /** Its project; null for a session of no project, which has no task. */
  readonly projectId: number | null;
  readonly taskId: number | null;
  readonly parentSessionId: string | null;
  readonly name: string | null;
  /** Never shown in the browser (`SessionStart.background`). */
  readonly background: boolean;
  /** Its run is in progress now (or input it was given is being admitted). */
  readonly running: boolean;
  /** The extension that started it (`SessionStart`), or null. */
  readonly startedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A session to start, with its first prompt. It needs a `source` or a `projectId` (or both). */
export interface SessionStart {
  /** Where it works: a source's ID, or a node and path (a directory no session used yet is checked on its
   * node). Without it, the project's: its task's latest session's source, else its default source. */
  readonly source?: number | Location;
  /** Its project; without it, the session has none (then `source` is required, and there is no task). */
  readonly projectId?: number;
  /** A task of the project. */
  readonly taskId?: number;
  readonly prompt: string;
  /** Its model; without it, the `default_model` setting's. */
  readonly model?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel?: ThinkingLevel };
  /** A background session: one the browser never shows (not listed, counted or badged); it runs, settles and
   * can be read like any other. */
  readonly background?: boolean;
  /** Its name; without it, it is named as any session is. */
  readonly title?: string;
}

/** How a run of a session ended: its status, the text of its final reply (null without one) and, for a run
 * that failed or was cancelled, why. */
export interface SessionSettlement {
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly result: string | null;
  readonly error: string | null;
}

/**
 * Sessions, as the agents' `api.sessions` has them, for the extension: it acts as no session, so it names
 * where a session works. What it starts and what it sends record the extension as their origin (the
 * session's `startedBy`; its messages' `metadata.sourceExtension`), which the chat shows ("from <name>").
 * Its messages reach the model as they are, like a user's: an extension is trusted code of the server.
 */
export interface Sessions {
  /** The session; rejects for one the server does not have. */
  get(sessionId: string): Promise<SessionInfo>;
  /**
   * Creates a session and submits its prompt; resolves with its ID once Pi admitted the prompt, without
   * waiting for the run. Rejects, keeping nothing, with neither a source nor a project, an unknown
   * project, task (or a task of another project), source or node, a path that is not a directory on its
   * node, a model the server does not have, a blank prompt or title, and a prompt the session refuses.
   */
  start(session: SessionStart): Promise<string>;
  /**
   * Submits `message` to the session, as the agents' `api.sessions.send` does: it steers it, so a running
   * session takes it into its work and an idle one starts a run with it; resolves once Pi admitted it, not
   * when the work ends. It does not look at whether the session is busy: `get` tells. Rejects for an unknown
   * session, a blank message and one the session refuses (its node was removed).
   */
  send(sessionId: string, message: string): Promise<void>;
  /**
   * Tells `listener` each time a run of a session this extension started ends, once its end is recorded,
   * with its outcome and final reply. Only the extension's own sessions (`startedBy`), and only while the
   * listener is registered: a run that ends while no app runs (during a dev reload's gap) is not told, so
   * read what a listener missed with `get`. A throw or rejection is the extension's error, logged.
   */
  onSettled(listener: (settlement: SessionSettlement) => void | Promise<void>): Disposer;
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
  /** `projectId` is null for a session of no project (it then has no task). */
  session: { id: string; projectId: number | null; taskId: number | null };
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
  /** Null when the agent's session has no project. */
  projectId: number | null;
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
