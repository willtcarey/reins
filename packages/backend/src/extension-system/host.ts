/**
 * The boundary between extension instances and the server (docs/dev/extensions-overview.md,
 * docs/dev/server-sdk.md). The core reads extensions only here, so it does not care where one came from.
 */

import { KindGuard, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  Disposer, HttpApi, HttpCall, ImagesProvider, Logger, PageHandler, PromptContext, PromptContribution, ScriptContext, ScriptNamespace,
  ServerSdk, Service, SessionSettlement, ToolFilters, ToolProvider, ToolResult, ToolSearchGroup,
} from "@reins/sdk/server";
import type { ExtensionStorage } from "../database.js";
import { scriptFunctions, scriptTypes, type ApiContext, type ScriptFunction } from "../sdk-host/projection.js";
import type { NamedType } from "../sdk-host/scripts.js";
import type { AppState, SessionSettledNotice } from "../state.js";
import { requestOrigin } from "../nodes/node-link.js";
import { logger } from "../logger.js";
import { ServiceRunner, type ServiceView } from "./services.js";
import { createExtensionSdk } from "./extension-sdk.js";

export type RouteScope = "api" | "pages";

/** A final tool ID: `<extension>__<local ID>`, as a model's tool names are. */
export const MAX_TOOL_ID_LENGTH = 64;
export const TOOL_ID_SEPARATOR = "__";
const LOCAL_ID = /^[a-zA-Z0-9_-]+$/;

export class UnknownToolError extends Error {
  constructor(id: string) {
    super(`Unknown tool: ${id}. Find tools with reins.tools.search(query).`);
    this.name = "UnknownToolError";
  }
}

export const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;
const METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const SCOPE_PREFIX: Record<RouteScope, string> = { api: "/api/extensions", pages: "/extensions" };
const API_CALL = new URLPattern({ pathname: `${SCOPE_PREFIX.api}/:extension/:method` });

/** A contribution's removal: idempotent, and done once its own cleanup (a service's stop) is. */
export type Removal = () => Promise<void>;

interface Page { extension: string; path: string; pattern: URLPattern; handler: PageHandler }
interface Method {
  extension: string;
  name: string;
  input: TSchema | null;
  answers: boolean;
  // Its input type is the method's schema's, which the host checks each input against before the call.
  handler: (call: HttpCall<any>) => unknown;
}
interface Script { extension: string; namespace: string; functions: ScriptFunction[]; types: NamedType[] }
interface RegisteredService { extension: string; runner: ServiceRunner }
interface SettlementListener { extension: string; listener: (settlement: SessionSettlement) => void | Promise<void> }

export interface ExtensionConnection {
  readonly sdk: ServerSdk;
  /** Services wait for this, so none runs before its register function has returned. */
  start(): void;
  /** Removes all it registered, also what its disposer forgot: a reloaded extension must leave nothing behind. */
  disconnect(dispose?: Disposer): Promise<void>;
}

export class ExtensionHost {
  private readonly providers: { extension: string; provider: ToolProvider }[] = [];
  readonly imageProviders = new Map<string, ImagesProvider>();
  private readonly prompts: { extension: string; contribution: PromptContribution }[] = [];
  private readonly scripts: Script[] = [];
  private readonly pages: Page[] = [];
  private readonly methods: Method[] = [];
  private readonly services: RegisteredService[] = [];
  private readonly settlementListeners: SettlementListener[] = [];

  /** `report`: an extension's error after it loaded (a tool ID left out, a prompt section that threw, a
   * service's crash), which must not reach the core's caller. */
  constructor(
    private readonly app: () => AppState,
    private readonly reservedNamespaces: ReadonlySet<string>,
    private readonly report: (extension: string, error: unknown) => void,
  ) {}

  connect(name: string, storage: ExtensionStorage): ExtensionConnection {
    const owned: Removal[] = [];
    let started = false;
    const sdk = createExtensionSdk({ name, storage, host: this, app: this.app, owned, started: () => started });
    return {
      sdk,
      start: () => {
        started = true;
        for (const { runner } of this.services.filter(service => service.extension === name)) runner.start();
      },
      disconnect: async (dispose) => {
        // Without a disposer to wait for, all goes at once (a removed service stops), so nothing it registered
        // outlives the call.
        if (!dispose) {
          await Promise.all(owned.splice(0).map(remove => remove()));
          return;
        }
        try {
          // Its services stop first: they may use what its disposer closes.
          await this.stopServices(name);
          await dispose?.();
        } finally {
          await Promise.all(owned.splice(0).map(remove => remove()));
        }
      },
    };
  }

  addToolProvider(extension: string, provider: ToolProvider): Removal {
    if (this.providers.some(entry => entry.extension === extension)) {
      throw new Error("An extension registers one tool provider: remove the one it has first");
    }
    return add(this.providers, { extension, provider });
  }

  addImageProvider(extension: string, provider: ImagesProvider): Removal {
    if (this.imageProviders.has(extension)) throw new Error("An extension registers one image provider at a time");
    this.imageProviders.set(extension, provider);
    return async () => { if (this.imageProviders.get(extension) === provider) this.imageProviders.delete(extension); };
  }

  addPromptContribution(extension: string, contribution: PromptContribution): Removal {
    return add(this.prompts, { extension, contribution });
  }

  addScriptNamespace(extension: string, namespace: ScriptNamespace): Removal {
    if (typeof namespace?.namespace !== "string") throw new Error("A script namespace needs its name (namespace)");
    if (this.reservedNamespaces.has(namespace.namespace) || this.scripts.some(script => script.namespace === namespace.namespace)) {
      throw new Error(`The script namespace ${namespace.namespace} is taken`);
    }
    if (typeof namespace.methods !== "object" || namespace.methods === null) throw new Error(`${namespace.namespace}: no methods`);
    return add(this.scripts, { extension, namespace: namespace.namespace, functions: scriptFunctions(namespace, scriptContextOf), types: scriptTypes(namespace) });
  }

  addPage(extension: string, path: string, handler: PageHandler): Removal {
    const fullPath = pagePath(extension, path);
    return add(this.pages, { extension, path: fullPath, pattern: new URLPattern({ pathname: fullPath }), handler });
  }

  /** All or none: a half-registered API would answer some calls of a client built for all of it. */
  addHttpApi(extension: string, api: HttpApi, handlers: Record<string, (call: HttpCall<any>) => unknown>): Removal {
    const methods = Object.entries(api).map(([method, { input, output }]): Method => {
      if (!METHOD_NAME.test(method)) throw new Error(`Not an HTTP method name: ${method}`);
      if (this.methods.some(entry => entry.extension === extension && entry.name === method)) throw new Error(`The ${extension} extension already handles ${method}`);
      // Only a schema the host can check may guard a handler.
      if (input !== undefined && !KindGuard.IsSchema(input)) throw new Error(`${method}: its input must be a TypeBox schema, which the host checks`);
      const handler = handlers[method];
      if (typeof handler !== "function") throw new Error(`${method}: no handler`);
      return { extension, name: method, input: input ?? null, answers: output !== undefined, handler };
    });
    const removals = methods.map(method => add(this.methods, method));
    return async () => { await Promise.all(removals.map(remove => remove())); };
  }

  addService(extension: string, service: Service, start: boolean): Removal {
    if (typeof service?.name !== "string" || !EXTENSION_NAME.test(service.name)) throw new Error(`Not a service name: ${String(service?.name)}`);
    if (typeof service.start !== "function") throw new Error(`Service ${service.name}: no start function`);
    if (this.services.some(entry => entry.extension === extension && entry.runner.name === service.name)) {
      throw new Error(`The ${extension} extension already has a service ${service.name}`);
    }
    const runner = new ServiceRunner(service.name, service, prefixed(`[${extension}:${service.name}]`), error => this.report(extension, error));
    const remove = add(this.services, { extension, runner }, () => runner.stop());
    if (start) runner.start();
    return remove;
  }

  addSettlementListener(extension: string, listener: (settlement: SessionSettlement) => void | Promise<void>): Removal {
    if (typeof listener !== "function") throw new Error("A settlement listener is a function");
    return add(this.settlementListeners, { extension, listener });
  }

  /** All at once: each is bounded by its own timeout, so one slow service does not hold up the others. */
  async stopServices(extension?: string): Promise<void> {
    await Promise.all(this.services.filter(service => extension === undefined || service.extension === extension).map(({ runner }) => runner.stop()));
  }

  registrationsOf(extension: string) {
    const own = <T extends { extension: string }>(entry: T) => entry.extension === extension;
    const provider = this.providers.find(own)?.provider;
    return {
      tools: provider ? { title: provider.title } : null,
      promptSections: this.prompts.filter(own).length,
      settlementListeners: this.settlementListeners.filter(own).length,
      scriptFunctions: this.scripts.filter(own).flatMap(script => script.functions.map(fn => fn.name)).toSorted(),
      httpMethods: this.methods.filter(own).map(method => method.name).toSorted(),
      pages: this.pages.filter(own).map(page => page.path).toSorted(),
    };
  }

  servicesOf(extension: string): ServiceView[] {
    return this.services.filter(service => service.extension === extension).map(({ runner }) => runner.view());
  }

  /** A query that starts with an extension's prefix reaches it without the prefix: an agent often searches for
   * an ID it already has. A tool whose ID breaks the rules is left out and reported, not thrown. */
  async searchTools(query: string, filters: ToolFilters, signal: AbortSignal): Promise<ToolSearchGroup[]> {
    return Promise.all([...this.providers].map(async ({ extension, provider }): Promise<ToolSearchGroup> => {
      const prefix = `${extension}${TOOL_ID_SEPARATOR}`;
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

  async callTool(id: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs?: number }): Promise<ToolResult> {
    const at = id.indexOf(TOOL_ID_SEPARATOR);
    const extension = id.slice(0, at);
    const localId = id.slice(at + TOOL_ID_SEPARATOR.length);
    const entry = at > 0 && LOCAL_ID.test(localId) ? this.providers.find(candidate => candidate.extension === extension) : undefined;
    if (!entry) throw new UnknownToolError(id);
    return entry.provider.call(localId, args, options);
  }

  scriptFunctions(): ScriptFunction[] {
    return this.scripts.flatMap(script => script.functions);
  }

  scriptTypes(): NamedType[] {
    return this.scripts.flatMap(script => script.types);
  }

  /** A section that throws is left out: one extension must not break every session's prompt. */
  async promptSections(context: PromptContext): Promise<string[]> {
    const sections = await Promise.all([...this.prompts].map(async ({ extension, contribution }) => {
      try {
        return await contribution(context);
      } catch (error) {
        this.report(extension, error);
        return null;
      }
    }));
    return sections.filter((section): section is string => !!section);
  }

  sessionSettled({ extension, ...settlement }: SessionSettledNotice): void {
    for (const entry of this.settlementListeners.filter(candidate => candidate.extension === extension)) {
      try {
        void Promise.resolve(entry.listener(settlement)).catch((error: unknown) => this.report(extension, error));
      } catch (error) {
        this.report(extension, error);
      }
    }
  }

  /** Asked at each request, so a reloaded extension's routes answer at once. */
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
}

export function pagePath(extension: string, path: string): string {
  return `${SCOPE_PREFIX.pages}/${extension}${path}`;
}

function add<T>(list: T[], item: T, onRemove?: () => Promise<void>): Removal {
  list.push(item);
  let removed: Promise<void> | undefined;
  return () => {
    if (removed) return removed;
    const index = list.indexOf(item);
    if (index >= 0) list.splice(index, 1);
    removed = onRemove?.() ?? Promise.resolve();
    return removed;
  };
}

/** What an extension's script method is told of the script's call: its session, and its signal. */
function scriptContextOf(ctx: ApiContext): ScriptContext {
  return { sessionId: ctx.session.id, projectId: ctx.session.projectId, taskId: ctx.session.taskId, ...(ctx.signal ? { signal: ctx.signal } : {}) };
}

function prefixed(prefix: string): Logger {
  return Object.freeze({
    debug: (...args: unknown[]) => logger.debug(prefix, ...args),
    info: (...args: unknown[]) => logger.info(prefix, ...args),
    warn: (...args: unknown[]) => logger.warn(prefix, ...args),
    error: (...args: unknown[]) => logger.error(prefix, ...args),
  });
}
