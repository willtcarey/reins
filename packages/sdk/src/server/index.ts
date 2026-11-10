/**
 * `@reins/sdk/server`: what a backend extension gets from the server (docs/dev/server-sdk.md). An extension's
 * register function takes a `ServerSdk` and returns its disposer, as a frontend extension does with
 * `@reins/sdk` (ADR-030). The server calls it each time it builds an app, and the disposer when that app
 * stops, so a reload registers the extension again on its new code.
 *
 * Types only, and it imports only its own modules and the type of the database (`bun:sqlite`'s `Database`, which its own `Database` extends): an extension
 * uses only what its register function is given. Each member's comment states its behavior; keep them accurate when the host changes
 * (`extension-system/host.ts`).
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
  /** Image models: list and use them, and register a provider of them. */
  readonly images: Images;
  readonly prompt: Prompt;
  readonly scripting: Scripting;
  readonly http: Http;
  readonly services: Services;
  /** Sessions: start them, message them, read them, and hear when the runs of those it started end. Call its
   * methods on it (`reins.sessions.send(…)`): taken off it, they lose it. */
  readonly sessions: Sessions;
  /** Nodes: the machines sessions work on, and files and commands on them. Call its methods on it, as for `sessions`. */
  readonly nodes: Nodes;
  readonly ui: Ui;
  /** The AI providers and their models. */
  readonly models: Models;
  /** Code reviews: a calling session's only, so an extension is refused (`Reviews`). */
  readonly reviews: Reviews;
  /** Projects. Call its methods on it, as for `sessions`. */
  readonly projects: Projects;
  /** Tasks, of any project. Call its methods on it, as for `sessions`. */
  readonly tasks: Tasks;
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
  /** The text of its first message (the user's, or what started it); null before it has one. */
  readonly firstMessage: string | null;
  /** How many messages its transcript has. */
  readonly messageCount: number;
  /** The model it runs; null before it has one. */
  readonly model: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: ThinkingLevel | "off" } | null;
  /** Never shown in the browser (`SessionStartOptions.background`). */
  readonly background: boolean;
  /** Its run is in progress now (or input it was given is being admitted). */
  readonly running: boolean;
  /** Its last run ended with something the user has not opened yet (the browser's amber dot). Reading a
   * session does not mark it read. */
  readonly unread: boolean;
  /** Pinned above the unpinned sessions of its lists. */
  readonly pinned: boolean;
  /** Archived: left out of the session lists. */
  readonly archived: boolean;
  /** The extension that started it, or null. */
  readonly startedBy: string | null;
  /** When its latest run started: the one running now, else the latest that ended; null before its first. A
   * message sent to a running session joins that run, so it does not change this. */
  readonly lastRunStartedAt: string | null;
  /** The latest of its runs that ended (completed, failed or cancelled), as an opaque ID to compare; null before
   * its first ends. A message `send` gave a running session is handled before that run ends, so a new
   * `lastRunId` after a send means that the run which took the message has ended. */
  readonly lastRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A message: its text, or its blocks in order. A block is a string (shown in the chat) or `{ text, hidden? }`.
 * The model gets every block. The chat shows the visible ones and collapses the hidden ones under the message,
 * for context the user need not read (a command's output, an automation's ID). Nothing tells the model which
 * blocks are hidden: say in them what it needs to know about them (e.g. that an output is not the user's words).
 * Visible blocks come first, at least one; no block is blank.
 */
export type MessageContent = string | readonly MessageBlock[];

export type MessageBlock = string | {
  readonly text: string;
  readonly hidden?: boolean;
  /** The first hidden block only: a heading the chat shows above the hidden blocks when opened (e.g. "Command
   * output"); the model does not get it. 1 to 80 characters. */
  readonly label?: string;
};

/** What a message carries beside its content, for the extension's own use: any plain JSON object of at most
 * 64 KiB, kept with it in the session's transcript. The model does not get it. The keys Reins sets itself
 * (`sourceExtension`, `sourceSessionId`, `details`) are refused. Extensions only. */
export type MessageMetadata = Readonly<Record<string, unknown>>;

/** A model to run a session with. */
export interface ModelChoice {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
}

/**
 * Where a session starts and how. From an agent's session (a script), what it leaves out is the caller's: its
 * project, its task (in its own project), its source and its model. An extension has no session: a session it
 * starts needs a `source` or a `projectId` (or both), and is of no project without one.
 */
export interface SessionStartOptions {
  /** `"current"`: a child of the calling session, which reports its outcome back to it (scripts only); null or
   * left out: an independent session. A script must give it. */
  readonly parentSessionId?: "current" | null;
  /** Its project (`"current"`: the calling session's). In another project than the caller's, it has no task
   * unless `taskId` names one of it, and works where that project's sessions work. */
  readonly projectId?: number | "current";
  /** A task of its project; `"current"` the calling session's; null for a session of no task. */
  readonly taskId?: number | null | "current";
  /** Where it works: a source's ID, or a node and path (a directory no session used yet is checked on its
   * node). Without it, the caller's (in its project), else the project's: its task's latest session's source,
   * else its default source. */
  readonly source?: number | Location | null;
  /** Its model; without it, the caller's, else the `default_model` setting's. */
  readonly model?: ModelChoice;
  /** Its name; without it, it is named as any session is. */
  readonly title?: string;
  /** A background session: one the browser never shows (not listed, counted or badged); it runs, settles and
   * can be read like any other. Extensions only. */
  readonly background?: boolean;
  /** The prompt's metadata (`MessageMetadata`). Extensions only. */
  readonly metadata?: MessageMetadata;
}

/** How much of a session's context window its context takes now. */
export interface ContextUsage {
  /** The tokens of its context: those its latest model response reported (`exact`), or an estimate after a
   * compaction until the next response (`estimated`). */
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly measurement: "exact" | "estimated";
}

/** How a run of a session ended: its status, the text of its final reply (null without one) and, for a run
 * that failed or was cancelled, why. */
export interface SessionSettlement {
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly result: string | null;
  readonly error: string | null;
}

/** What `Sessions.wait` saw: a run's end (`completed`, `failed`, `cancelled`), a session at rest with no reply
 * (`idle`), or its time running out (`timeout`). */
export interface SessionWaitResult {
  readonly sessionId: string;
  readonly status: "idle" | "completed" | "failed" | "cancelled" | "timeout";
  readonly result: string | null;
  readonly error: string | null;
}

/**
 * Which sessions `Sessions.list` gives. By default those the browser lists (not archived, not background): of
 * the calling session's project (a session of no project: those of no project on its source), pinned first,
 * then the latest change; for an extension, of every project and of none, the latest change first, 50 at a time.
 */
export interface SessionListQuery {
  /** A project's sessions; `"current"`: the calling session's project. */
  readonly projectId?: number | "current";
  /** One task's sessions (`"current"`: the calling session's), or null for the project's sessions of no task. */
  readonly taskId?: number | null | "current";
  /** Only those changed since then (an ISO time). */
  readonly since?: string;
  /** 1 to 200. */
  readonly limit?: number;
  readonly offset?: number;
  /** Words in its ID, name, task's title or messages. */
  readonly search?: string;
  /** Only those with at least this many messages. */
  readonly minMessages?: number;
  /** `"exclude"` (the default), `"only"` or `"include"` background sessions. */
  readonly background?: "exclude" | "only" | "include";
}

/** Which entries of a session's transcript `Sessions.entries` gives. */
export interface SessionEntryQuery {
  readonly types?: readonly ("user" | "assistant" | "compactionSummary" | "toolCall")[];
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly since?: string;
  readonly afterSeq?: number;
  readonly beforeSeq?: number;
  readonly limit?: number;
  readonly search?: string;
  readonly order?: "asc" | "desc";
  /** Give tool results' whole content, not only a preview. */
  readonly includeContent?: boolean;
}

/** An entry of a session's transcript: a message, or a tool call with its result joined. */
export type SessionEntry =
  | {
    readonly sessionId: string;
    readonly seq: number;
    readonly createdAt: string;
    readonly type: "user" | "assistant" | "compactionSummary";
    readonly role: string;
    readonly content?: unknown;
    readonly summary?: string;
  }
  | {
    readonly sessionId: string;
    readonly seq: number;
    readonly createdAt: string;
    readonly type: "toolCall";
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly result: { readonly seq: number; readonly createdAt: string; readonly isError: boolean; readonly contentPreview: string; readonly content?: unknown } | null;
  };

/**
 * Sessions, as agents' `reins.sessions` has them: any session can be read, messaged, waited for and changed. The
 * caller decides the defaults (`SessionStartOptions`, `SessionListQuery`) and the origin of what it starts and
 * sends: an extension's sessions and messages record it (the session's `startedBy`; its messages'
 * `metadata.sourceExtension`), which the chat shows ("from <name>"); its messages reach the model as they are,
 * like a user's, as an extension is trusted code of the server. `"current"` names the calling session, its
 * project or its task, and an extension, which has none, is refused it.
 */
export interface Sessions {
  /** The session; rejects for one the server does not have ("Session not found: <id>"). */
  get(sessionId: string): Promise<SessionInfo>;
  /** The calling session; an extension has none, and is refused. */
  current(): Promise<SessionInfo>;
  /** The sessions `query` asks for (`SessionListQuery`). Rejects a `limit` or `offset` out of range. */
  list(query?: SessionListQuery): Promise<SessionInfo[]>;
  /** The entries of its transcript (`SessionEntryQuery`). */
  entries(sessionId: string, query?: SessionEntryQuery): Promise<SessionEntry[]>;
  /**
   * Creates a session and submits its prompt; resolves with its ID once Pi admitted the prompt, without
   * waiting for the run. Rejects, keeping nothing, for a place it cannot be (no source and no project from an
   * extension, an unknown project, task (or a task of another project), source or node, a path that is not a
   * directory on its node), a model the server does not have, a blank prompt or title, a child more than 3
   * deep; a prompt the session refuses rejects and leaves the session, to be sent to again or moved.
   */
  start(prompt: MessageContent, options?: SessionStartOptions): Promise<{ sessionId: string }>;
  /**
   * Submits `message` to the session: it steers it, so a running session takes it into its work and an idle
   * one starts a run with it; resolves once Pi admitted it, not when the work ends. It does not look at whether
   * the session is busy: `get` tells. From a script it reaches the model as a session update from the caller.
   * Rejects for an unknown session, content or metadata their rules refuse (`MessageContent`,
   * `MessageMetadata`), and one the session refuses (its node was removed).
   */
  send(sessionId: string, message: MessageContent, options?: { readonly metadata?: MessageMetadata }): Promise<void>;
  /**
   * Waits for the session to be at rest, at most `timeoutMs` (0 to 30 000; 10 000 by default), and gives its
   * latest outcome. A session at rest answers at once. Rejects for an unknown session, and for a script's own.
   */
  wait(sessionId: string, timeoutMs?: number): Promise<SessionWaitResult>;
  /**
   * Compacts the session's context now (a summary replaces its history; `instructions` focus the summary),
   * as the composer's `/compact` does, in order with what was submitted to it before. Resolves once the
   * compaction started, not when it ends: the session reads `running` until then. Rejects for an unknown
   * session, a running one ("compact it once it is idle") and one with nothing to compact. The model already
   * compacts by itself near the context limit: this is for a lower limit of the caller's own.
   */
  compact(sessionId: string, options?: { readonly instructions?: string }): Promise<void>;
  /** How full the session's context is (`ContextUsage`); null when it is not known (no model yet, or one the
   * server no longer has). Rejects for an unknown session. */
  contextUsage(sessionId: string): Promise<ContextUsage | null>;
  /** Sets its model from its next turn on; `thinkingLevel` defaults to its own. Rejects for a model the server
   * does not have. */
  setModel(sessionId: string, provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<SessionInfo>;
  /** Renames it (trimmed, not blank), or with null gives it back its fallback label. */
  setName(sessionId: string, name: string | null): Promise<SessionInfo>;
  setPinned(sessionId: string, pinned: boolean): Promise<SessionInfo>;
  setArchived(sessionId: string, archived: boolean): Promise<SessionInfo>;
  /**
   * Tells `listener` each time a run of a session this extension started ends, once its end is recorded,
   * with its outcome and final reply. Only the extension's own sessions (`startedBy`), and only while the
   * listener is registered: a run that ends while no app runs (during a dev reload's gap) is not told, so
   * read what a listener missed with `get`. A throw or rejection is the extension's error, logged. Extensions only.
   */
  onSettled(listener: (settlement: SessionSettlement) => void | Promise<void>): Disposer;
}

// ---------------------------------------------------------------------------
// Projects and tasks
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  readonly id: number;
  readonly name: string;
  /** The branch its tasks' branches start from and its diffs compare with. */
  readonly baseBranch: string;
  /** Its default source: where it was created, where a new session of it works unless told otherwise. */
  readonly defaultSourceId: number | null;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

/** Projects. Any project can be read; `"current"` and `current()` are the calling session's (scripts only). */
export interface Projects {
  list(): Promise<ProjectInfo[]>;
  /** The project; rejects for one the server does not have ("Project not found: <id>"). */
  get(projectId: number): Promise<ProjectInfo>;
  /** The calling session's project, or null for a session of no project; an extension has none, and is refused. */
  current(): Promise<ProjectInfo | null>;
  /** Creates a project whose default source is `path` on node `nodeId` (by default the calling session's node;
   * an extension must name it), a directory there; detects its base branch there unless given. */
  create(name: string, path: string, baseBranch?: string, nodeId?: string): Promise<ProjectInfo>;
}

export interface TaskInfo {
  readonly id: number;
  readonly projectId: number;
  readonly title: string;
  readonly description: string | null;
  /** The git branch its sessions work on. */
  readonly branchName: string;
  /** What its diffs compare with, when not its project's base branch. */
  readonly baseCommit: string | null;
  readonly status: "open" | "closed";
  /** When it was closed; null while it is open. Reopening it clears this. */
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What `Tasks.update` changes; what it leaves out is kept. */
export interface TaskChanges {
  readonly title?: string;
  readonly description?: string;
  readonly baseCommit?: string;
}

/** Tasks, of any project; a project left out (or `"current"`) is the calling session's, which an extension
 * must name, and a session of no project too (tasks belong to projects). */
export interface Tasks {
  /** The project's tasks, open ones first; only those of `status` when given. */
  list(status?: "open" | "closed", projectId?: number | "current"): Promise<TaskInfo[]>;
  /** The task; rejects for one the server does not have ("Task not found: <id>"). */
  get(taskId: number): Promise<TaskInfo>;
  /** The calling session's task, or null for a session of no task; an extension has none, and is refused. */
  current(): Promise<TaskInfo | null>;
  /** Creates a task and names its branch (from the title unless `branchName` is given); no checkout is touched. */
  create(title: string, description: string, branchName?: string, projectId?: number | "current"): Promise<TaskInfo>;
  update(taskId: number, changes: TaskChanges): Promise<TaskInfo>;
  close(taskId: number): Promise<TaskInfo>;
  reopen(taskId: number): Promise<TaskInfo>;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** How a command ended. */
export interface CommandResult {
  /** Its exit code (128 + the signal's number when a signal killed it). */
  readonly exitCode: number;
  /** stdout and stderr together, as text: at most the first 16 MiB. */
  readonly output: string;
  /** The output was longer than what `output` holds. */
  readonly truncated: boolean;
}

export interface CommandOptions {
  /** Where it starts: absolute, `~/…`, or relative to the node's home (the default). */
  readonly cwd?: string;
  /** 1 to 600 000 (10 min); 30 000 by default. A command still running then is killed, and `run` rejects. */
  readonly timeoutMs?: number;
  /**
   * Added to the node's own environment for the command. A value given here is not in the command's text, so it
   * needs no quoting and is not in the process's arguments (a secret: `printf '%s' "$KEY" >> .env`).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Aborting it kills the command, and `run` rejects. Give a service's `signal`, so a reload ends it. */
  readonly signal?: AbortSignal;
}

/** What `Nodes.spawn` takes. */
export interface ProcessOptions {
  /** Where it starts: absolute, `~/…`, or relative to the node's home (the default). */
  readonly cwd?: string;
  /** Added to the node's environment. Sent to the node only to start the process: neither kept nor logged
   * there, so a secret may go here (never in the command's text). */
  readonly env?: Readonly<Record<string, string>>;
  /** The longest stdout line `lines` gives, in bytes: 8 MiB by default, at most 64 MiB. */
  readonly maxLineBytes?: number;
  /** Aborting it stops the process. Give a service's `signal`. */
  readonly signal?: AbortSignal;
}

/** How a process ended: its exit code, or the signal that ended it; `error` when it ended for another reason than
 * its own (its node's link dropped, a stdout line was too long, its stdout was not read). */
export interface NodeProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: string;
}

/**
 * A process running on a node (`Nodes.spawn`), which the server writes to and reads from, as an MCP client does a
 * stdio server. It ends when it exits, when it is stopped, when its node's link drops (the node stops it: nothing
 * reattaches, so start it again) and when its extension is unloaded.
 */
export interface NodeProcess {
  readonly id: string;
  readonly nodeId: string;
  readonly pid: number;
  /** Its stdout as whole lines, without their `\n` (or `\r\n`), a last line without one at the end. A line longer
   * than `maxLineBytes` stops the process and throws. Read either this or `chunks`, once, and keep reading: stdout
   * nobody reads fails the process once 64 MiB are waiting. */
  readonly lines: AsyncIterable<string>;
  /** Its stdout as the node read it. */
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Writes to its stdin (text as UTF-8), in order; resolves once the process has taken the bytes. Rejects once it
   * has exited or its input is closed, and when it holds 16 MiB it has not taken yet. */
  write(data: string | Uint8Array): Promise<void>;
  /** Closes its stdin once earlier writes are taken. */
  closeInput(): Promise<void>;
  /** The last 64 KiB characters of its stderr, to say why it failed. */
  stderrTail(): string;
  /** Hears its stderr as it comes. */
  onStderr(listener: (text: string) => void): Disposer;
  /** Resolves (never rejects) when it has ended. */
  readonly exited: Promise<NodeProcessExit>;
  /** Closes its stdin, then sends SIGTERM to its process group (what it started too), and SIGKILL after a few
   * seconds; resolves once it has ended. */
  stop(): Promise<NodeProcessExit>;
}

/** A node as `Nodes.list` gives it. */
export interface NodeInfo {
  readonly id: string;
  readonly name: string;
  /** The machine's hostname, as it said when it paired; null for a node never paired (the local one). */
  readonly hostname: string | null;
  readonly connected: boolean;
  /** Revoked: it may not connect. */
  readonly revoked: boolean;
  /** The calling session runs its tools on it (never, for an extension). */
  readonly current: boolean;
  /** How many sources (directories sessions work in) are in use on it. */
  readonly sourceCount: number;
}

export interface NodeDetail extends NodeInfo {
  /** The sources in use on it, by path, each with the projects whose sessions work there or whose default source it is. */
  readonly sources: readonly { readonly sourceId: number; readonly path: string; readonly projects: readonly { readonly id: number; readonly name: string }[] }[];
}

/**
 * Nodes: the machines sessions work on, and files and commands on any of them. A node is named by its ID (stable:
 * prefer it to keep) or its name (any case); `"current"` is the calling session's (scripts only), also the default
 * where a node may be left out, so an extension names it. Nothing is confined: files and commands are the node's
 * user's, as a session's are. An unknown or removed node rejects ("Node not found: <node> (the nodes: …)"), and one
 * that is not connected now too ("Node unavailable: …"): nothing waits for it. What a call reads is held in the
 * server's memory: at most 16 MiB.
 */
export interface Nodes {
  /** The nodes not removed, in name order. */
  list(): Promise<NodeInfo[]>;
  /** A node with the sources in use on it. */
  get(node?: string): Promise<NodeDetail>;
  /** Restarts a node on its current code; resolves once the reload is scheduled. `force`: after 60 s, cut off the
   * calls still in flight instead of giving up. */
  reload(node?: string, force?: boolean): Promise<{ nodeId: string; scheduled: true }>;
  /** A whole file, as text (UTF-8) or with `binary` as bytes; a file over 16 MiB rejects (copy it with `copy`). */
  readFile(node: string, path: string, options?: { readonly binary?: boolean; readonly signal?: AbortSignal }): Promise<string | Uint8Array>;
  /** Writes a whole file, making its directories and replacing a file there. */
  writeFile(node: string, path: string, content: string | Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Copies a file of any size from one node to another (or within one); the file there is replaced once the whole
   * file has arrived. */
  copy(fromNode: string, fromPath: string, toNode: string, toPath: string, options?: { readonly signal?: AbortSignal }): Promise<{ bytes: number }>;
  /**
   * Runs a bash command on a node. A command that fails resolves with its exit code; `run` rejects for a blank
   * command, a timeout out of range (an extension's: 1 to 600 000), the timeout and the signal.
   */
  run(node: string, command: string, options?: CommandOptions): Promise<CommandResult>;
  /**
   * Starts a long-running process on a node: `command` as argv (no shell) or a `/bin/sh -c` command. Resolves once
   * it runs. Rejects for a blank command, an environment variable that is not `[A-Za-z_][A-Za-z0-9_]*`, an unknown,
   * removed or disconnected node, a directory that is not there, a program not on the node's `PATH`, and a node that
   * already runs as many processes as it may (64). Extensions only: agents' scripts do not have it.
   */
  spawn(node: string, command: string | readonly string[], options?: ProcessOptions): Promise<NodeProcess>;
}

// ---------------------------------------------------------------------------
// UI, models and code reviews
// ---------------------------------------------------------------------------

/** What browsers show. */
export interface Ui {
  /** Sends any frontend message to every browser (debugging; `ServerSdk.broadcast` is the extension's own channel). */
  broadcast(message: unknown): Promise<string>;
  /** Opens a file in the file browser of the users viewing a session (a script's own; an extension names it with
   * `sessionId`), highlighting `startLine`–`endLine`; rejects when the file is not on the node. */
  openFile(path: string, options?: { readonly node?: string; readonly startLine?: number; readonly endLine?: number; readonly sessionId?: string }): Promise<string>;
}

/** An AI provider and its models. */
export interface ProviderInfo {
  readonly runtimeType: string;
  readonly provider: string;
  readonly isAvailable: boolean;
  readonly availabilitySource: "db" | "env" | "oauth" | "local" | null;
  readonly availabilitySources: readonly ("db" | "env" | "oauth" | "local")[];
  readonly models: readonly { readonly id: string; readonly name: string; readonly reasoning: boolean; readonly contextWindow: number; readonly maxTokens: number }[];
}

export interface Models {
  list(): Promise<ProviderInfo[]>;
  listProviders(): Promise<string[]>;
}

/** A pending code review: its annotations (comments anchored in a diff, with their threads). */
export interface CodeReview {
  readonly id: string;
  readonly projectId: number;
  readonly taskId: number | null;
  readonly revision: number;
  readonly annotations: readonly unknown[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The pending code review of the calling session's project and task. It is about that session's branch diff, so
 * an extension, which has none, is refused. */
export interface Reviews {
  current(): Promise<CodeReview | null>;
  addComment(path: string, line: number, body: string, options?: { readonly endLine?: number; readonly side?: "old" | "new"; readonly author?: string }): Promise<CodeReview>;
}

/** A JSON Schema object, as JSON Schema defines it (a TypeBox schema is one). */
export type JsonSchema = object;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** An image, as content blocks carry one (the shape of Pi's and MCP's image content). */
export interface ImageBlock {
  type: "image";
  /** Base64, without a `data:` prefix. */
  data: string;
  mimeType: string;
}

/** What an agent asks a model for. */
export interface ImageRequest {
  prompt: string;
  /** Images to edit. */
  images?: ImageBlock[];
  /** E.g. `1024x1024`. */
  size?: string;
  count?: number;
  /** The provider's own parameters, given as they are. */
  parameters?: Readonly<Record<string, unknown>>;
}

/** Where an extension's image models come from. It is asked at each list and each generation. */
export interface ImagesProvider {
  /** Its model IDs now, without whitespace. Agents see `<extension>__<id>`. */
  models(signal: AbortSignal): Promise<string[]>;
  /** A failure throws, and the throw reaches the agent's script. */
  generate(model: string, request: ImageRequest, signal: AbortSignal): Promise<ImageBlock[]>;
}

export interface Images {
  /** Every provider's model IDs, `<extension>__<model>` (a provider's throw rejects the list). */
  list(options?: { readonly signal?: AbortSignal }): Promise<string[]>;
  /** Makes images with `model` (by default the first listed); `images` takes what a script's `image()` takes. */
  generate(prompt: string, options?: { readonly model?: string; readonly images?: unknown; readonly size?: string; readonly count?: number; readonly parameters?: Readonly<Record<string, unknown>>; readonly signal?: AbortSignal }): Promise<{ model: string; images: ImageBlock[] }>;
  /** One per extension: a second throws while the first is registered. */
  registerProvider(provider: ImagesProvider): Disposer;
}

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

/** A tool an agent can call through `reins.tools.call(id, args)`. */
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

/** What an agent gives `reins.tools.search` to narrow it, given to every provider as it is. Each provider decides
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

/** What one provider answered a search: its matching tools (by their final IDs, best first), or why it could not. */
export type ToolSearchGroup = { readonly title: string; readonly tools: readonly Tool[] } | { readonly title: string; readonly error: string };

export interface ToolSearchOptions {
  /** Given to every provider as they are (`ToolFilters`). */
  readonly filters?: ToolFilters;
  readonly signal?: AbortSignal;
}

export interface ToolCallOptions {
  /** How long to wait for it; the provider's default otherwise. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Tools {
  /**
   * The tools of every extension (its own too) that match `query` and `options.filters`, as agents' `reins.tools.search`
   * finds them: each provider asked at the same time, in the order of registration, its tools by their final IDs
   * (`<extension>__<local ID>`). A provider that throws is a group with its `error`, and the others still answer.
   */
  search(query: string, options?: ToolSearchOptions): Promise<ToolSearchGroup[]>;
  /**
   * Runs a tool by its final ID, as agents' `reins.tools.call` does, on the provider of the extension its prefix names.
   * A failure the tool reports is a result with `isError`; an unknown ID ("Unknown tool: …") and a tool that cannot
   * be run reject.
   */
  call(id: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolResult>;
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
// Scripting: an extension's own `reins.<namespace>` in `execute`
// ---------------------------------------------------------------------------

/**
 * A positional argument of a method that agents' scripts call (`reins.<namespace>.<method>(…)`): its name, as `search`
 * documents it, and its schema, which the host checks a script's argument against before the call. Only the last
 * arguments may be `optional`. A property of an object schema with `scripts: false` (an `AbortSignal`, an option only
 * an extension may set) is not for scripts: `search` leaves it out, and a script that gives it is refused.
 */
export interface ScriptParam {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly optional?: boolean;
}

/** The arguments that `params` declare, in order: each its schema's type, the optional ones possibly left out. */
export type ScriptArgs<P extends readonly ScriptParam[]> = P extends readonly [infer Head extends ScriptParam, ...infer Rest extends readonly ScriptParam[]]
  ? Head extends { readonly optional: true }
    ? [arg?: SchemaType<Head["schema"]>, ...rest: ScriptArgs<Rest>]
    : [arg: SchemaType<Head["schema"]>, ...rest: ScriptArgs<Rest>]
  : [];

/**
 * A method callable from agents' scripts, declared once: its documentation (`search` shows `description`, the
 * params and `returns`, and matches `tags`), the schemas a script's arguments are checked against, and `run`,
 * its implementation, whose arguments are the params' types. `context` says who calls it. A script gets what `run`
 * resolves to, or `toScript` of it when `returns` documents another form (what an agent reads best).
 */
export interface ScriptMethod<C, P extends readonly ScriptParam[], R extends JsonSchema, T = SchemaType<R>> {
  readonly description: string;
  readonly params: P;
  readonly returns: R;
  /** Lowercase words `search` also matches. */
  readonly tags: readonly string[];
  run(context: C, ...args: ScriptArgs<P>): Promise<T>;
  toScript?(result: T, ...args: ScriptArgs<P>): SchemaType<R>;
}

/** What an extension's script method runs for: the agent's session (its script's caller), and its script's signal. */
export interface ScriptContext {
  sessionId: string;
  /** Null when the agent's session has no project. */
  projectId: number | null;
  taskId: number | null;
  signal?: AbortSignal;
}

/** A `ScriptMethod` of any arguments, as a namespace holds them. */
export interface AnyScriptMethod<C> {
  readonly description: string;
  readonly params: readonly ScriptParam[];
  readonly returns: JsonSchema;
  readonly tags: readonly string[];
  run(context: C, ...args: any[]): Promise<unknown>;
  toScript?(result: any, ...args: any[]): unknown;
}

/**
 * A namespace of `reins` in `execute`, which `search` documents: the core's (`reins.sessions`, the SDK's own methods)
 * and an extension's (`reins.mcp`). A script calls `reins.<namespace>.<method>(…)` with positional arguments, in the
 * order of the method's `params`, checked against their schemas before `run`. Its result reaches the script as it
 * is; a throw reaches it as an error.
 */
export interface ScriptNamespace<C = ScriptContext> {
  /** Lowercase letters and digits, starting with a letter: `mcp` for `reins.mcp`. */
  readonly namespace: string;
  /** By name (`[a-z][A-Za-z0-9]*`): `list` for `reins.mcp.list(…)`. */
  readonly methods: Readonly<Record<string, AnyScriptMethod<C>>>;
  /** Schemas that `search` shows by their name where a method's params or result use them (by identity). */
  readonly types?: Readonly<Record<string, JsonSchema>>;
}

export interface Scripting {
  /** Adds a namespace to scripts' `reins`. It must not be the core's or another registration's, and its params' schemas must be
   * TypeBox schemas (the host checks a script's arguments with them): else it throws. */
  register(namespace: ScriptNamespace): Disposer;
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
