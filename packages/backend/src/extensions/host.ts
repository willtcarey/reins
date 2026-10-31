/**
 * The host of backend extensions (docs/dev/server-sdk.md): what one app's extensions registered through the
 * server SDK (`@reins/sdk/server`), and the SDK object each one gets. `createAppState` builds one and
 * registers the extensions; the app's `stop` disposes it. The core reads it: `api.tools` (`searchTools`,
 * `callTool`), `api.<namespace>` (`scriptFunctions`), the system prompt (`promptSections`) and
 * `/api/extensions/…` and `/extensions/…` (`handle`).
 */

import type { TObject, TProperties, TSchema } from "@sinclair/typebox";
import type {
  Disposer, JsonSchema, PromptContext, PromptContribution, RegisterExtension, RouteGroup, RouteHandler, ScriptFunction, ScriptType, ServerSdk,
  ToolFilters, ToolResult, ToolSource,
} from "@reins/sdk/server";
import type { ApiFunctionDef } from "../scripting/define-function.js";
import type { NamedType } from "../scripting/api-registry.js";
import type { ServerProcess } from "../state.js";
import { createBroadcast } from "../models/broadcast.js";
import { requestOrigin } from "../nodes/node-link.js";
import { logger } from "../logger.js";
import { decrypt, encrypt } from "../crypto.js";
import { matchTools, type ToolSearchGroup } from "./tool-docs.js";

/** A backend extension as the server registers it: its name and its register function. */
export interface ExtensionRegistration { name: string; register: RegisterExtension }

/** Where a route is: the extension's API (`/api/extensions/<name>`) or its pages (`/extensions/<name>`). */
export type RouteScope = "api" | "pages";

export class UnknownToolError extends Error {
  constructor(id: string) {
    super(`Unknown tool: ${id}. Find tools with api.tools.search(query).`);
    this.name = "UnknownToolError";
  }
}

const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;
const SCOPE_PREFIX: Record<RouteScope, string> = { api: "/api/extensions", pages: "/extensions" };

interface Route { extension: string; scope: RouteScope; method: string; pattern: URLPattern; handler: RouteHandler }
interface Script { namespace: string; functions: ApiFunctionDef[]; types: NamedType[] }

/** A schema an extension gave, as the core's renderer takes it: the renderer reads JSON Schema fields only. */
function isSchema(_schema: JsonSchema): _schema is TSchema {
  return true;
}

function isObjectSchema(schema: JsonSchema): schema is TObject<TProperties> {
  return isSchema(schema) && schema.type === "object";
}

export class ExtensionHost {
  /** Each kind of registration, in the order of registration. */
  private readonly sources: ToolSource[] = [];
  private readonly contributions: { extension: string; contribution: PromptContribution }[] = [];
  private readonly scripts: Script[] = [];
  private readonly routes: Route[] = [];
  private readonly disposers: { name: string; dispose: Disposer }[] = [];
  private readonly names = new Set<string>();

  /** `process`: what the SDK's database and broadcast are. `reservedNamespaces`: the core's `api`
   * namespaces, which no extension may take. `onError`: what an extension's failure to register or dispose
   * is told to. */
  constructor(
    private readonly process: Pick<ServerProcess, "db" | "broadcast">,
    private readonly reservedNamespaces: ReadonlySet<string>,
    private readonly onError: (extension: string, error: unknown) => void,
  ) {}

  /** Calls the extension's register function with an SDK of its own. A throw is told to `onError`, and
   * what it registered before it threw is removed. */
  register({ name, register }: ExtensionRegistration): void {
    if (!EXTENSION_NAME.test(name)) throw new Error(`Not an extension name: ${name}`);
    if (this.names.has(name)) throw new Error(`Extension already registered: ${name}`);
    this.names.add(name);
    const owned: Disposer[] = [];
    try {
      const dispose = register(this.sdkFor(name, owned));
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

  /** Every source's tools that match, by source in the order of registration. */
  async searchTools(query: string, filters: ToolFilters, signal: AbortSignal): Promise<ToolSearchGroup[]> {
    return Promise.all([...this.sources].map(async (source): Promise<ToolSearchGroup> => {
      try {
        return { title: source.title, tools: await source.search(query, { filters, signal }) };
      } catch (error) {
        return { title: source.title, error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  /** Runs tool `id` on the first source that claims it; `UnknownToolError` when none does. */
  async callTool(id: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs?: number }): Promise<ToolResult> {
    // A copy: a source may be removed while an earlier one runs.
    for (const source of this.sources.slice()) {
      const result = await source.call(id, args, options);
      if (result !== null) return result;
    }
    throw new UnknownToolError(id);
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

  /** Answers a request under `/api/extensions/<extension>/` or `/extensions/<extension>/` from the route it
   * matches; null when none does. */
  async handle(scope: RouteScope, req: Request, url: URL): Promise<Response | null> {
    for (const route of this.routes) {
      if (route.scope !== scope || route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = decodeURIComponent(value);
      }
      return route.handler({ req, url, params, origin: requestOrigin(req) });
    }
    return null;
  }

  private sdkFor(name: string, owned: Disposer[]): ServerSdk {
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
    const group = (scope: RouteScope): RouteGroup => {
      const route = (method: string) => (path: string, handler: RouteHandler) =>
        add(this.routes, { extension: name, scope, method, pattern: new URLPattern({ pathname: `${SCOPE_PREFIX[scope]}/${name}${path}` }), handler });
      return Object.freeze({ get: route("GET"), post: route("POST"), put: route("PUT"), patch: route("PATCH"), delete: route("DELETE") });
    };
    const serverProcess = this.process;
    const broadcast = createBroadcast(serverProcess);
    return Object.freeze({
      name,
      get db() { return serverProcess.db; },
      logger,
      secrets: Object.freeze({ encrypt, decrypt }),
      broadcast: (message: object) => broadcast({ type: "extension", extension: name, message }),
      tools: Object.freeze({
        register: (source: ToolSource) => add(this.sources, source),
        match: matchTools,
      }),
      prompt: Object.freeze({
        register: (contribution: PromptContribution) => add(this.contributions, { extension: name, contribution }),
      }),
      scripting: Object.freeze({
        register: ({ functions, types = [] }: { functions: readonly ScriptFunction[]; types?: readonly ScriptType[] }) =>
          add(this.scripts, this.script(functions, types)),
      }),
      routes: Object.freeze({
        api: group("api"),
        pages: group("pages"),
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
        if (!isObjectSchema(fn.parameters) || !isSchema(fn.returns)) throw new Error(`${fn.name}: its parameters must be an object schema`);
        return {
          name: fn.name, description: fn.description, parameters: fn.parameters, returns: fn.returns, async: fn.async, tags: fn.tags,
          execute: (params, ctx) => fn.execute(params, { sessionId: ctx.sessionId, projectId: ctx.projectId, taskId: ctx.taskId, signal: ctx.signal }),
        };
      }),
      types: types.flatMap(type => isSchema(type.schema) ? [{ name: type.name, schema: type.schema }] : []),
    };
  }
}

function removeAll(disposers: Disposer[]): void {
  for (const dispose of disposers.splice(0)) void dispose();
}
