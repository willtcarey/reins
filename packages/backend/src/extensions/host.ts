/**
 * The host of backend extensions (docs/dev/server-sdk.md): what one app's extensions registered through the
 * server SDK (`@reins/sdk/server`), and the SDK object each one gets. `createAppState` builds one and
 * registers the extensions; the app's `stop` disposes it. The core reads it: `api.tools` (`searchTools`,
 * `callTool`), `api.images` (`imageProviders`), `api.<namespace>` (`scriptFunctions`), the system prompt (`promptSections`) and
 * `/api/extensions/…` and `/extensions/…` (`handle`), and Settings' Extensions section (`list`).
 */

import { KindGuard, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  Database, Disposer, HttpApi, HttpCall, ImagesProvider, Logger, Migration, PageHandler, PromptContext, PromptContribution, ScriptFunction, ScriptType, SecretStorage, ServerExtension, ServerSdk,
  Service, SessionSettlement, ToolFilters, ToolResult, ToolProvider, ToolSearchGroup,
} from "@reins/sdk/server";
import { statSync } from "fs";
import type { ExtensionStorage } from "../database.js";
import { namedArgs, type ApiFunctionDef } from "../scripting/define-function.js";
import type { NamedType } from "../scripting/api-registry.js";
import type { AppState, SessionSettledNotice } from "../state.js";
import { ExtensionNodes } from "./nodes.js";
import { createBroadcast } from "../models/broadcast.js";
import { requestOrigin } from "../nodes/node-link.js";
import { logger } from "../logger.js";
import { deleteExtensionSecret, extensionSecretKeys, getExtensionSecret, setExtensionSecret } from "../extension-secrets-store.js";
import { matchTools } from "./tool-docs.js";
import { ServiceRunner, type ServiceView } from "./services.js";
import { Models } from "../models/models.js";
import { bind, type CallContext } from "../sdk-host/declaration.js";
import { TOOLS } from "../sdk-host/tools.js";
import { SESSIONS } from "../sdk-host/sessions.js";
import { PROJECTS, TASKS } from "../sdk-host/projects.js";

/** A backend extension as the server registers it: its name, its migrations and its register function. */
export interface ExtensionRegistration extends ServerExtension { name: string }

/** Where a request is: the extension's API (`/api/extensions/<name>`) or its pages (`/extensions/<name>`). */
export type RouteScope = "api" | "pages";

/** A final tool ID: `<extension>__<local ID>`, as a model's tool names are. */
export const MAX_TOOL_ID_LENGTH = 64;
const SEPARATOR = "__";
const LOCAL_ID = /^[a-zA-Z0-9_-]+$/;

export class UnknownToolError extends Error {
  constructor(id: string) {
    super(`Unknown tool: ${id}. Find tools with api.tools.search(query).`);
    this.name = "UnknownToolError";
  }
}

const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;
const METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SCOPE_PREFIX: Record<RouteScope, string> = { api: "/api/extensions", pages: "/extensions" };
const API_CALL = new URLPattern({ pathname: `${SCOPE_PREFIX.api}/:extension/:method` });

interface Page { extension: string; path: string; pattern: URLPattern; handler: PageHandler }
interface Method {
  extension: string;
  name: string;
  input: TSchema | null;
  answers: boolean;
  // Its input type is the method's schema's, which the host checks each input against before the call.
  handler: (call: HttpCall<any>) => unknown;
}
interface Script { extension: string; namespace: string; functions: ApiFunctionDef[]; types: NamedType[] }
interface RegisteredService { extension: string; runner: ServiceRunner }
interface SettlementListener { extension: string; listener: (settlement: SessionSettlement) => void | Promise<void> }

/** What the host knows of an extension of this app: its storage once opened, and what went wrong. */
interface ExtensionRecord {
  name: string;
  migrations: readonly Migration[];
  storage: ExtensionStorage | null;
  failure: ExtensionView["failure"];
  errors: ExtensionView["errors"];
  /** Its register function returned: its services start, those it registers later at once. */
  loaded: boolean;
}

/** How many of an extension's later errors the host keeps: enough to see a pattern, not a log. */
const KEPT_ERRORS = 10;

/**
 * An extension as the host reports it (`GET /api/extensions`). `status` is `loaded` when it registered in this
 * app, `failed` when `failure` stopped it (its storage could not be opened, a migration or its register
 * function threw); a later switch would add `disabled`. `registrations` are what it has registered now: a
 * disposed one is gone. Secrets are only counted.
 */
export interface ExtensionView {
  name: string;
  status: "loaded" | "failed";
  failure: { stage: "storage" | "migration" | "register"; message: string } | null;
  /** Errors reported after it loaded (a tool ID left out, a prompt section that threw), the latest last; at most 10. */
  errors: { message: string; at: string }[];
  registrations: {
    /** Its tool provider. No count of tools: that would ask the provider, which may go to the network. */
    tools: { title: string } | null;
    promptSections: number;
    /** Its `reins.sessions.onSettled` listeners. */
    settlementListeners: number;
    scriptFunctions: string[];
    httpMethods: string[];
    /** Each page's path from the server's root. */
    pages: string[];
  };
  /** Its services now, in the order of registration, each with its state. */
  services: ServiceView[];
  /** Null when its directory and database could not be opened. */
  storage: {
    dataDir: string;
    /** `db.sqlite` with its WAL file, on disk. */
    databaseBytes: number;
    migrations: { applied: { id: string; appliedAt: string }[]; pending: string[] };
    /** How many secrets it keeps: not their keys, which can name the user's things (a server's ID), nor values. */
    secrets: number;
  } | null;
}

// The core's registry and renderer are typed with TypeBox but read only JSON Schema fields, so any JSON
// Schema object works there. The check is at runtime because an extension without TypeScript can give anything.
function isSchema(schema: unknown): schema is TSchema {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

function isObjectSchema(schema: unknown): schema is TObject<TProperties> {
  return isSchema(schema) && "type" in schema && schema.type === "object";
}

function schemaOf(name: string, schema: unknown): TSchema {
  if (!isSchema(schema)) throw new Error(`${name}: not a JSON Schema object`);
  return schema;
}

export class ExtensionHost {
  /** Each extension's tool provider. */
  private readonly providers: { extension: string; provider: ToolProvider }[] = [];
  /** Each extension's image provider, by extension name. */
  readonly imageProviders = new Map<string, ImagesProvider>();
  private readonly contributions: { extension: string; contribution: PromptContribution }[] = [];
  private readonly scripts: Script[] = [];
  private readonly pages: Page[] = [];
  private readonly methods: Method[] = [];
  private readonly services: RegisteredService[] = [];
  private readonly settlementListeners: SettlementListener[] = [];
  private readonly disposers: { name: string; dispose: Disposer }[] = [];
  private readonly records = new Map<string, ExtensionRecord>();

  /** `app`: the app the host is of, read when an extension registers (the host is built with it): its process
   * has each extension's directory and database and the broadcast, and its sessions and nodes are what
   * `reins.sessions` and `reins.nodes` reach. `reservedNamespaces`: the core's `api` namespaces, which no
   * extension may take. `onError`: what an extension's failure to register or dispose is told to. */
  constructor(
    private readonly app: () => AppState,
    private readonly reservedNamespaces: ReadonlySet<string>,
    private readonly onError: (extension: string, error: unknown) => void,
  ) {}

  /** Opens the extension's directory and database, applies its pending migrations, then calls its register
   * function with an SDK of its own. A failure of either is told to `onError`: a failed migration keeps the
   * extension from registering, and what a register function registered before it threw is removed. */
  register({ name, migrations = [], register }: ExtensionRegistration): void {
    if (!EXTENSION_NAME.test(name)) throw new Error(`Not an extension name: ${name}`);
    if (this.records.has(name)) throw new Error(`Extension already registered: ${name}`);
    const record: ExtensionRecord = { name, migrations, storage: null, failure: null, errors: [], loaded: false };
    this.records.set(name, record);
    let storage: ExtensionStorage;
    try {
      storage = this.app().process.extensionData.open(name);
    } catch (error) {
      this.fail(record, "storage", error);
      return;
    }
    record.storage = storage;
    try {
      migrate(storage.db, migrations, name);
    } catch (error) {
      this.fail(record, "migration", error);
      return;
    }
    const owned: Disposer[] = [];
    try {
      const dispose = register(this.sdkFor(record, storage, owned));
      // Its services stop first: they may use what its disposer closes.
      this.disposers.push({ name, dispose: async () => {
        try {
          await this.stopServices(name);
          await dispose();
        } finally {
          await removeAll(owned);
        }
      } });
    } catch (error) {
      void removeAll(owned);
      this.fail(record, "register", error);
      return;
    }
    record.loaded = true;
    for (const { runner } of this.services.filter(service => service.extension === name)) runner.start();
  }

  /** Stops the services of `extension`, or of every extension, all at once: each is bounded by its own timeout. */
  private async stopServices(extension?: string): Promise<void> {
    await Promise.all(this.services.filter(service => extension === undefined || service.extension === extension).map(({ runner }) => runner.stop()));
  }

  /** Each extension of this app, in the order of registration (`ExtensionView`). */
  list(): ExtensionView[] {
    return [...this.records.values()].map(record => {
      const own = <T extends { extension: string }>(entry: T) => entry.extension === record.name;
      const provider = this.providers.find(own)?.provider;
      return {
        name: record.name,
        status: record.failure ? "failed" : "loaded",
        failure: record.failure,
        errors: [...record.errors],
        registrations: {
          tools: provider ? { title: provider.title } : null,
          promptSections: this.contributions.filter(own).length,
          settlementListeners: this.settlementListeners.filter(own).length,
          scriptFunctions: this.scripts.filter(own).flatMap(script => script.functions.map(fn => fn.name)).toSorted(),
          httpMethods: this.methods.filter(own).map(method => method.name).toSorted(),
          pages: this.pages.filter(own).map(page => page.path).toSorted(),
        },
        services: this.services.filter(own).map(({ runner }) => runner.view()),
        storage: record.storage && storageView(record.name, record.storage, record.migrations),
      };
    });
  }

  private fail(record: ExtensionRecord, stage: NonNullable<ExtensionView["failure"]>["stage"], error: unknown): void {
    record.failure = { stage, message: errorMessage(error) };
    this.onError(record.name, error);
  }

  /** An extension's error after it loaded: kept for its report, and told to `onError`. */
  private report(extension: string, error: unknown): void {
    const errors = this.records.get(extension)?.errors;
    if (errors) {
      errors.push({ message: errorMessage(error), at: new Date().toISOString() });
      errors.splice(0, errors.length - KEPT_ERRORS);
    }
    this.onError(extension, error);
  }

  /** Stops every service, then disposes every extension, the last registered first, and removes all they
   * registered. */
  async dispose(): Promise<void> {
    await this.stopServices();
    for (const { name, dispose } of this.disposers.splice(0).toReversed()) {
      try { await dispose(); } catch (error) { this.onError(name, error); }
    }
    this.records.clear();
  }

  /** Every provider's tools that match, by provider in the order of registration, with their final IDs. A
   * query that starts with an extension's prefix reaches that extension without it (an agent that searches
   * for an ID it has). A tool whose ID breaks the rules is left out and reported. */
  async searchTools(query: string, filters: ToolFilters, signal: AbortSignal): Promise<ToolSearchGroup[]> {
    return Promise.all([...this.providers].map(async ({ extension, provider }): Promise<ToolSearchGroup> => {
      const prefix = `${extension}${SEPARATOR}`;
      const own = query.trim().startsWith(prefix) ? query.trim().slice(prefix.length) : query;
      try {
        const tools = await provider.search(own, { filters, signal });
        return { title: provider.title, tools: tools.flatMap(tool => {
          const problem = !LOCAL_ID.test(tool.id) ? "a local ID is [a-zA-Z0-9_-]+"
            : prefix.length + tool.id.length > MAX_TOOL_ID_LENGTH ? `${prefix}${tool.id} is longer than ${MAX_TOOL_ID_LENGTH} characters`
            : null;
          if (!problem) return [{ ...tool, id: `${prefix}${tool.id}` }];
          this.report(extension, new Error(`Tool ID ${tool.id} is left out: ${problem}`));
          return [];
        }) };
      } catch (error) {
        return { title: provider.title, error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  /** Runs tool `id` on the provider of the extension its prefix names, with its local ID; `UnknownToolError`
   * when there is none, or the ID is not one. */
  async callTool(id: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs?: number }): Promise<ToolResult> {
    const at = id.indexOf(SEPARATOR);
    const extension = id.slice(0, at);
    const localId = id.slice(at + SEPARATOR.length);
    const entry = at > 0 && LOCAL_ID.test(localId) ? this.providers.find(candidate => candidate.extension === extension) : undefined;
    if (!entry) throw new UnknownToolError(id);
    return entry.provider.call(localId, args, options);
  }

  /** The extensions' `api` functions, as the core's registry holds functions. */
  scriptFunctions(): ApiFunctionDef[] {
    return this.scripts.flatMap(script => script.functions);
  }

  /** The named types their functions use. */
  scriptTypes(): NamedType[] {
    return this.scripts.flatMap(script => script.types);
  }

  /** Every contribution's section, in the order of registration; a throw is told to `onError` and left out. */
  async promptSections(context: PromptContext): Promise<string[]> {
    const sections = await Promise.all([...this.contributions].map(async ({ extension, contribution }) => {
      try {
        return await contribution(context);
      } catch (error) {
        this.report(extension, error);
        return null;
      }
    }));
    return sections.filter((section): section is string => !!section);
  }

  /** Tells the settlement listeners of the extension that started the session how its run ended; a throw or
   * rejection is that extension's error. */
  sessionSettled({ extension, ...settlement }: SessionSettledNotice): void {
    for (const entry of this.settlementListeners.filter(candidate => candidate.extension === extension)) {
      try {
        void Promise.resolve(entry.listener(settlement)).catch((error: unknown) => this.report(extension, error));
      } catch (error) {
        this.report(extension, error);
      }
    }
  }

  /** Answers a request under `/api/extensions/<extension>/` (a method's call) or `/extensions/<extension>/` (a
   * page); null when no method or page is there. */
  async handle(scope: RouteScope, req: Request, url: URL): Promise<Response | null> {
    if (scope === "api") return this.call(req, url);
    if (req.method !== "GET") return null;
    for (const page of this.pages) {
      const match = page.pattern.exec(url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = decodeURIComponent(value);
      }
      return page.handler({ req, url, params, origin: requestOrigin(req) });
    }
    return null;
  }

  private async call(req: Request, url: URL): Promise<Response | null> {
    const names = API_CALL.exec(url)?.pathname.groups;
    const method = req.method === "POST" ? this.methods.find(entry => entry.extension === names?.extension && entry.name === names?.method) : undefined;
    if (!method) return null;
    const text = await req.text();
    let input: unknown;
    if (method.input) {
      try {
        input = text ? JSON.parse(text) : undefined;
      } catch {
        return Response.json({ error: "Invalid JSON in request body" }, { status: 400 });
      }
      if (!Value.Check(method.input, input)) {
        const first = Value.Errors(method.input, input).First();
        return Response.json({ error: `Invalid input: ${first ? `${first.path || "/"}: ${first.message}` : "does not match"}` }, { status: 400 });
      }
    }
    try {
      const output = await method.handler({ input, signal: req.signal, origin: requestOrigin(req) });
      return method.answers ? Response.json(output ?? null) : new Response(null, { status: 204 });
    } catch (error) {
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      if (typeof status === "number" && status >= 400 && status < 600) return Response.json({ error: error instanceof Error ? error.message : "" }, { status });
      throw error;
    }
  }

  private sdkFor(record: ExtensionRecord, { dataDir, db }: ExtensionStorage, owned: Disposer[]): ServerSdk {
    const { name } = record;
    /** Adds to `list`; its removal (then `onRemove`, awaited), which the extension's disposal also runs. */
    const add = <T>(list: T[], item: T, onRemove?: () => Promise<void>): Disposer => {
      list.push(item);
      let removed: Promise<void> | undefined;
      const remove = () => {
        if (removed) return removed;
        const index = list.indexOf(item);
        if (index >= 0) list.splice(index, 1);
        removed = onRemove?.() ?? Promise.resolve();
        return removed;
      };
      owned.push(remove);
      return remove;
    };
    const registerService = (service: Service): Disposer => {
      if (typeof service?.name !== "string" || !EXTENSION_NAME.test(service.name)) throw new Error(`Not a service name: ${String(service?.name)}`);
      if (typeof service.start !== "function") throw new Error(`Service ${service.name}: no start function`);
      if (this.services.some(entry => entry.extension === name && entry.runner.name === service.name)) {
        throw new Error(`The ${name} extension already has a service ${service.name}`);
      }
      const runner = new ServiceRunner(service.name, service, prefixed(`[${name}:${service.name}]`), error => this.report(name, error));
      const dispose = add(this.services, { extension: name, runner }, () => runner.stop());
      if (record.loaded) runner.start();
      return dispose;
    };
    const handleApi = (api: HttpApi, handlers: Record<string, (call: HttpCall<any>) => unknown>): Disposer => {
      const methods = Object.entries(api).map(([method, { input, output }]): Method => {
        if (!METHOD_NAME.test(method)) throw new Error(`Not an HTTP method name: ${method}`);
        if (this.methods.some(entry => entry.extension === name && entry.name === method)) throw new Error(`The ${name} extension already handles ${method}`);
        // Only a schema the host can check may guard a handler.
        if (input !== undefined && !KindGuard.IsSchema(input)) throw new Error(`${method}: its input must be a TypeBox schema, which the host checks`);
        const handler = handlers[method];
        if (typeof handler !== "function") throw new Error(`${method}: no handler`);
        return { extension: name, name: method, input: input ?? null, answers: output !== undefined, handler };
      });
      const removals = methods.map(method => add(this.methods, method));
      return () => { for (const remove of removals) void remove(); };
    };
    const broadcast = createBroadcast(this.app().process);
    // Each call gets the app's models of that moment, as the extension acts as no session.
    const context = (): CallContext => ({ models: new Models(this.app()), caller: { kind: "extension", name } });
    return Object.freeze({
      name,
      dataDir,
      db,
      logger,
      secrets: secretStorage(name),
      broadcast: (message: object) => broadcast({ type: "extension", extension: name, message }),
      tools: Object.freeze({
        ...bind(TOOLS.methods, context),
        register: (provider: ToolProvider) => {
          if (this.providers.some(entry => entry.extension === name)) {
            throw new Error("An extension registers one tool provider: remove the one it has first");
          }
          return add(this.providers, { extension: name, provider });
        },
        maxLocalIdLength: MAX_TOOL_ID_LENGTH - name.length - SEPARATOR.length,
        match: matchTools,
      }),
      images: Object.freeze({
        registerProvider: (provider: ImagesProvider) => {
          if (this.imageProviders.has(name)) throw new Error("An extension registers one image provider at a time");
          this.imageProviders.set(name, provider);
          const remove = () => { if (this.imageProviders.get(name) === provider) this.imageProviders.delete(name); };
          owned.push(remove);
          return remove;
        },
      }),
      services: Object.freeze({ register: registerService }),
      sessions: Object.freeze({
        ...bind(SESSIONS.methods, context),
        onSettled: (listener: (settlement: SessionSettlement) => void | Promise<void>) => {
          if (typeof listener !== "function") throw new Error("A settlement listener is a function");
          return add(this.settlementListeners, { extension: name, listener });
        },
      }),
      nodes: Object.freeze(new ExtensionNodes(this.app())),
      projects: Object.freeze(bind(PROJECTS.methods, context)),
      tasks: Object.freeze(bind(TASKS.methods, context)),
      prompt: Object.freeze({
        register: (contribution: PromptContribution) => add(this.contributions, { extension: name, contribution }),
      }),
      scripting: Object.freeze({
        register: ({ functions, types = [] }: { functions: readonly ScriptFunction[]; types?: readonly ScriptType[] }) =>
          add(this.scripts, this.script(name, functions, types)),
      }),
      http: Object.freeze({
        handle: handleApi,
        page: (path: string, handler: PageHandler) => {
          const fullPath = `${SCOPE_PREFIX.pages}/${name}${path}`;
          return add(this.pages, { extension: name, path: fullPath, pattern: new URLPattern({ pathname: fullPath }), handler });
        },
        pagePath: (path: string) => `${SCOPE_PREFIX.pages}/${name}${path}`,
      }),
    });
  }

  /** An extension's functions in the core's form; throws when their namespace is taken. */
  private script(extension: string, functions: readonly ScriptFunction[], types: readonly ScriptType[]): Script {
    const namespaces = new Set(functions.map(fn => fn.name.split(".")[0]!));
    if (namespaces.size !== 1) throw new Error("A registration's functions must share one api namespace");
    const namespace = [...namespaces][0]!;
    if (this.reservedNamespaces.has(namespace) || this.scripts.some(script => script.namespace === namespace)) {
      throw new Error(`The api namespace ${namespace} is taken`);
    }
    return {
      extension,
      namespace,
      functions: functions.map((fn): ApiFunctionDef => {
        if (!/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(fn.name)) throw new Error(`Not an api function name: ${fn.name}`);
        const { parameters } = fn;
        if (!isObjectSchema(parameters)) throw new Error(`${fn.name}: its parameters must be an object schema`);
        return {
          name: fn.name, description: fn.description, parameters, returns: schemaOf(fn.name, fn.returns), async: fn.async, tags: fn.tags,
          call: (args, ctx) => fn.execute(namedArgs(parameters, args), { sessionId: ctx.session.id, projectId: ctx.session.projectId, taskId: ctx.session.taskId, signal: ctx.signal }),
        };
      }),
      types: types.map(type => ({ name: type.name, schema: schemaOf(type.name, type.schema) })),
    };
  }
}

/** What the extension keeps: its directory, its database's size and migrations, and its secrets' keys. */
function storageView(extension: string, { dataDir, db }: ExtensionStorage, migrations: readonly Migration[]): NonNullable<ExtensionView["storage"]> {
  let applied: { id: string; appliedAt: string }[] = [];
  try {
    applied = db.query<{ id: string; appliedAt: string }, []>("SELECT id, applied_at AS appliedAt FROM reins_migrations ORDER BY rowid").all();
  } catch {
    // No table yet: the migrations' check failed before the host made it.
  }
  const ids = new Set(applied.map(migration => migration.id));
  return {
    dataDir,
    databaseBytes: fileSize(db.filename) + fileSize(`${db.filename}-wal`),
    migrations: { applied, pending: migrations.map(migration => migration.id).filter(id => !ids.has(id)) },
    secrets: extensionSecretKeys(extension).length,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Applies the migrations `db` has not recorded, in order, each in a transaction with its record. */
function migrate(db: Database, migrations: readonly Migration[], extension: string): void {
  const ids = new Set<string>();
  for (const { id } of migrations) {
    if (typeof id !== "string" || !id) throw new Error("A migration's id must be a non-empty string");
    if (ids.has(id)) throw new Error(`Two migrations have the id ${id}`);
    ids.add(id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reins_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(db.query<{ id: string }, []>("SELECT id FROM reins_migrations").all().map(row => row.id));
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO reins_migrations (id) VALUES (?)").run(migration.id);
    })();
    logger.info(`  Extension ${extension}: migration applied: ${migration.id}`);
  }
}

const MAX_SECRET_KEY_LENGTH = 256;

/** The extension's secrets: its keys only. Async, as the contract is (a keychain could hold them later). */
function secretStorage(extension: string): SecretStorage {
  const checked = (key: unknown): string => {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_SECRET_KEY_LENGTH) {
      throw new Error(`A secret's key is a string of 1 to ${MAX_SECRET_KEY_LENGTH} characters`);
    }
    return key;
  };
  return Object.freeze({
    get: async (key: string) => getExtensionSecret(extension, checked(key)),
    set: async (key: string, value: string) => {
      if (typeof value !== "string") throw new Error("A secret's value is a string");
      setExtensionSecret(extension, checked(key), value);
    },
    delete: async (key: string) => deleteExtensionSecret(extension, checked(key)),
    keys: async (prefix = "") => {
      if (typeof prefix !== "string") throw new Error("A prefix is a string");
      return extensionSecretKeys(extension, prefix);
    },
  });
}

async function removeAll(disposers: Disposer[]): Promise<void> {
  await Promise.all(disposers.splice(0).map(dispose => dispose()));
}

function prefixed(prefix: string): Logger {
  return Object.freeze({
    debug: (...args: unknown[]) => logger.debug(prefix, ...args),
    info: (...args: unknown[]) => logger.info(prefix, ...args),
    warn: (...args: unknown[]) => logger.warn(prefix, ...args),
    error: (...args: unknown[]) => logger.error(prefix, ...args),
  });
}
