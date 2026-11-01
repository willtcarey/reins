/**
 * The host of backend extensions (docs/dev/server-sdk.md): what one app's extensions registered through the
 * server SDK (`@reins/sdk/server`), and the SDK object each one gets. `createAppState` builds one and
 * registers the extensions; the app's `stop` disposes it. The core reads it: `api.tools` (`searchTools`,
 * `callTool`), `api.<namespace>` (`scriptFunctions`), the system prompt (`promptSections`) and
 * `/api/extensions/…` and `/extensions/…` (`handle`).
 */

import { KindGuard, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  Database, Disposer, HttpApi, HttpCall, Migration, PageHandler, PromptContext, PromptContribution, ScriptFunction, ScriptType, SecretStorage, ServerExtension, ServerSdk,
  ToolFilters, ToolResult, ToolProvider,
} from "@reins/sdk/server";
import type { ExtensionStorage } from "../database.js";
import type { ApiFunctionDef } from "../scripting/define-function.js";
import type { NamedType } from "../scripting/api-registry.js";
import type { ServerProcess } from "../state.js";
import { createBroadcast } from "../models/broadcast.js";
import { requestOrigin } from "../nodes/node-link.js";
import { logger } from "../logger.js";
import { deleteExtensionSecret, extensionSecretKeys, getExtensionSecret, setExtensionSecret } from "../extension-secrets-store.js";
import { matchTools, type ToolSearchGroup } from "./tool-docs.js";

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

interface Page { pattern: URLPattern; handler: PageHandler }
interface Method {
  extension: string;
  name: string;
  input: TSchema | null;
  answers: boolean;
  // Its input type is the method's schema's, which the host checks each input against before the call.
  handler: (call: HttpCall<any>) => unknown;
}
interface Script { namespace: string; functions: ApiFunctionDef[]; types: NamedType[] }

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
  private readonly contributions: { extension: string; contribution: PromptContribution }[] = [];
  private readonly scripts: Script[] = [];
  private readonly pages: Page[] = [];
  private readonly methods: Method[] = [];
  private readonly disposers: { name: string; dispose: Disposer }[] = [];
  private readonly names = new Set<string>();

  /** `process`: each extension's directory and database, and the broadcast. `reservedNamespaces`: the core's `api`
   * namespaces, which no extension may take. `onError`: what an extension's failure to register or dispose
   * is told to. */
  constructor(
    private readonly process: Pick<ServerProcess, "extensionData" | "broadcast">,
    private readonly reservedNamespaces: ReadonlySet<string>,
    private readonly onError: (extension: string, error: unknown) => void,
  ) {}

  /** Opens the extension's directory and database, applies its pending migrations, then calls its register
   * function with an SDK of its own. A failure of either is told to `onError`: a failed migration keeps the
   * extension from registering, and what a register function registered before it threw is removed. */
  register({ name, migrations = [], register }: ExtensionRegistration): void {
    if (!EXTENSION_NAME.test(name)) throw new Error(`Not an extension name: ${name}`);
    if (this.names.has(name)) throw new Error(`Extension already registered: ${name}`);
    this.names.add(name);
    let storage: ExtensionStorage;
    try {
      storage = this.process.extensionData.open(name);
      migrate(storage.db, migrations, name);
    } catch (error) {
      this.onError(name, error);
      return;
    }
    const owned: Disposer[] = [];
    try {
      const dispose = register(this.sdkFor(name, storage, owned));
      this.disposers.push({ name, dispose: async () => { try { await dispose(); } finally { removeAll(owned); } } });
    } catch (error) {
      removeAll(owned);
      this.onError(name, error);
    }
  }

  /** Disposes every extension, the last registered first, and removes all they registered. */
  async dispose(): Promise<void> {
    for (const { name, dispose } of this.disposers.splice(0).toReversed()) {
      try { await dispose(); } catch (error) { this.onError(name, error); }
    }
    this.names.clear();
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
          this.onError(extension, new Error(`Tool ID ${tool.id} is left out: ${problem}`));
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
        this.onError(extension, error);
        return null;
      }
    }));
    return sections.filter((section): section is string => !!section);
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

  private sdkFor(name: string, { dataDir, db }: ExtensionStorage, owned: Disposer[]): ServerSdk {
    /** Adds to `list`; its removal, which the extension's disposal also runs. */
    const add = <T>(list: T[], item: T): Disposer => {
      list.push(item);
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        const index = list.indexOf(item);
        if (index >= 0) list.splice(index, 1);
      };
      owned.push(remove);
      return remove;
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
    const broadcast = createBroadcast(this.process);
    return Object.freeze({
      name,
      dataDir,
      db,
      logger,
      secrets: secretStorage(name),
      broadcast: (message: object) => broadcast({ type: "extension", extension: name, message }),
      tools: Object.freeze({
        register: (provider: ToolProvider) => {
          if (this.providers.some(entry => entry.extension === name)) {
            throw new Error("An extension registers one tool provider: remove the one it has first");
          }
          return add(this.providers, { extension: name, provider });
        },
        maxLocalIdLength: MAX_TOOL_ID_LENGTH - name.length - SEPARATOR.length,
        match: matchTools,
      }),
      prompt: Object.freeze({
        register: (contribution: PromptContribution) => add(this.contributions, { extension: name, contribution }),
      }),
      scripting: Object.freeze({
        register: ({ functions, types = [] }: { functions: readonly ScriptFunction[]; types?: readonly ScriptType[] }) =>
          add(this.scripts, this.script(functions, types)),
      }),
      http: Object.freeze({
        handle: handleApi,
        page: (path: string, handler: PageHandler) => add(this.pages, { pattern: new URLPattern({ pathname: `${SCOPE_PREFIX.pages}/${name}${path}` }), handler }),
        pagePath: (path: string) => `${SCOPE_PREFIX.pages}/${name}${path}`,
      }),
    });
  }

  /** An extension's functions in the core's form; throws when their namespace is taken. */
  private script(functions: readonly ScriptFunction[], types: readonly ScriptType[]): Script {
    const namespaces = new Set(functions.map(fn => fn.name.split(".")[0]!));
    if (namespaces.size !== 1) throw new Error("A registration's functions must share one api namespace");
    const namespace = [...namespaces][0]!;
    if (this.reservedNamespaces.has(namespace) || this.scripts.some(script => script.namespace === namespace)) {
      throw new Error(`The api namespace ${namespace} is taken`);
    }
    return {
      namespace,
      functions: functions.map((fn): ApiFunctionDef => {
        if (!/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(fn.name)) throw new Error(`Not an api function name: ${fn.name}`);
        if (!isObjectSchema(fn.parameters)) throw new Error(`${fn.name}: its parameters must be an object schema`);
        return {
          name: fn.name, description: fn.description, parameters: fn.parameters, returns: schemaOf(fn.name, fn.returns), async: fn.async, tags: fn.tags,
          execute: (params, ctx) => fn.execute(params, { sessionId: ctx.sessionId, projectId: ctx.projectId, taskId: ctx.taskId, signal: ctx.signal }),
        };
      }),
      types: types.map(type => ({ name: type.name, schema: schemaOf(type.name, type.schema) })),
    };
  }
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

function removeAll(disposers: Disposer[]): void {
  for (const dispose of disposers.splice(0)) void dispose();
}
