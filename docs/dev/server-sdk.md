# The Server SDK

The server SDK is what a backend extension gets from the server: the backend's match of the frontend's Reins SDK ([reins-sdk.md](reins-sdk.md), ADR-030). An extension's register function takes it and returns a disposer. It is the "Reins-owned seam" stage of [extension-architecture.md](extension-architecture.md) (*Interface maturity*): an explicit interface with Reins values, which built-in code uses. It is not a plugin system yet: see *Not built yet*.

An **extension** is code that contributes to Reins only through an SDK. It can have a backend part (this SDK) and a frontend part (the Reins SDK). The MCP servers ([mcp-servers.md](mcp-servers.md)) are the first built-in extension.

## Where it lives

```
packages/backend/src/
  sdk/server/index.ts     # @reins/sdk/server: types only
  extensions/             # the host
    host.ts               #   ExtensionHost: the registrations of one app, and each extension's SDK object
    built-in.ts           #   BUILT_IN_EXTENSIONS: the one place that imports a built-in extension
    tool-docs.ts          #   api.tools.search's answer and the matching (`tools.match`)
    mcp/                  #   the MCP extension (backend part)
  scripting/tools.ts      # api.tools.search / api.tools.call
  routes/extensions.ts    # /api/extensions/:extension/* and /extensions/:extension/*
packages/frontend/src/extensions/mcp/   # the MCP extension (frontend part)
```

- **`@reins/sdk/server`** (`sdk/server/index.ts`) is a `tsconfig.json` `paths` alias, in the backend and in each package that typechecks backend sources (frontend, client, CLI). It is types only. It imports only its own modules and the type of `bun:sqlite`'s `Database` (lint: `reins/server-sdk-isolation`). Each member's comment states its behavior (lifecycle, order, errors): keep them accurate when the host changes.
- **The boundary** (lint: `reins/backend-extension-boundary`): a backend extension (`extensions/<name>/`) imports only `@reins/sdk/server`, its own modules and npm packages. Nothing outside it imports it, except `extensions/built-in.ts` (its registration) and its frontend part (frontend `extensions/<name>/`, for its types). Tests are not checked. When an extension needs something that the SDK does not give, add it to the SDK: do not make an exception.
- **This is a boundary between modules, not a security boundary.** An extension runs in the server process.

## Lifecycle

- **`createAppState`** (`state.ts`) builds the app's `ExtensionHost` (`AppState.extensions`) and registers each extension of `BUILT_IN_EXTENSIONS`, in order, with an SDK object of its own (`ServerSdk`: its `name`, and what it registers is recorded as its). Tests give `createAppState` their own list (`extensions`) and a handler for failures (`onExtensionError`; by default they are logged).
- **The app's `stop`** (`server.ts`) awaits `extensions.dispose()`: each extension's disposer, the last registered first, then the removal of all it registered, also what its disposer forgot. A disposer can return a promise (MCP closes its connections).
- **A hot reload** builds a new app, so each extension is registered again on its new code. What must outlive an app is in the database.
- **A register function that throws** is reported, and what it registered before the throw is removed. The other extensions still register.
- **Each registration returns its own disposer** (`Disposer`), as in the frontend.

## What an extension contributes

- **Tools** (`tools.register(provider)`). An extension has one `ToolProvider` at a time (registering a second while it has one throws). A provider has a `title`, `search(query, { filters, signal }) → Tool[]` and `call(localId, args, { signal, timeoutMs }) → ToolResult`, which throws for an ID that is none of its tools. A `Tool` is `{ id, name, title?, description?, inputSchema, outputSchema?, annotations? }`, with JSON Schema. `tools.match(query, tools)` ranks as the core does (*Agents and `api.tools`*).
  - **A provider gives local IDs; agents see final IDs.** The final ID is `<extension>__<local ID>`: the host adds the extension's name and `__` to each tool a search finds (`ExtensionHost.searchTools`), and `api.tools.search` documents the final IDs. A local ID is `[a-zA-Z0-9_-]+`, at most `tools.maxLocalIdLength` characters (64 less the prefix), so that a final ID can also be a model's tool name later. It must be unique among the extension's tools and stable: a duplicate is the extension's error. A tool whose ID breaks these rules is left out of the search's answer and reported as the extension's error (logged): the host never changes an ID.
  - **Why the host prefixes IDs.** In Reins, tools are found on demand: there is no registry of tools, unlike bb and Pi, which register tools before a call. The prefix lets the host route a call without a map, also for an ID from before a reload or from an earlier run, and it makes collisions between extensions impossible. Extension names have no `_`, so the first `__` always splits an ID correctly.
  - **The core asks the providers at each search and each call.** A search asks all of them at the same time. A provider that throws is shown in its place, and the others still answer. A query that starts with an extension's prefix reaches that extension without it (an agent that searches for a final ID it has). A call splits its ID at the first `__` and gives the local ID to that extension's provider. An ID without `__`, of no extension or of one without a provider, or whose local ID is not `[a-zA-Z0-9_-]+`, is `UnknownToolError`: no provider is asked.
- **System prompt sections** (`prompt.register(contribution)`). A contribution gets a `PromptContext` (`session` `{ id, projectId, taskId }`, its `task`, and the `tools` the model is offered, null for every tool) and returns text or null, possibly async. The core asks when a session's runtime opens (`SessionModel.context`, through `App.promptSections` of the current app). Only the Reins agent kind gets the sections: they follow the whole Reins section (task included), in the order of registration. A throw is reported, and the session opens without that section.
- **Scripting functions** (`scripting.register({ functions, types? })`): an extension's own `api.<namespace>` in `execute`, documented by `search`. A `ScriptFunction` is the core's `defineFunction` shape with JSON Schema (`parameters` must be an object schema; its properties are the positional arguments). `execute` gets the params and a `ScriptContext` (`sessionId`, `projectId`, `taskId`, `signal`). `types` are named schemas that `search` shows by name. A registration's functions share one namespace, which must not be a core namespace or another registration's (that throws). `scriptingApi(extensions)` (`scripting/api-registry.ts`) gives the core's functions and types plus the extensions'. `runScript` and `search` use it.
- **HTTP routes** (`routes.api.get/post/put/patch/delete(path, handler)` under `/api/extensions/<name>`, `routes.pages.…` under `/extensions/<name>`, `routes.pagePath(path)` for a page's path from the root). A handler gets a `RouteRequest` (`req`, `url`, decoded `params`, `origin`: the origin the browser used, from `X-Forwarded-*`, for callback URLs) and returns a `Response`. A throw is logged and answered 500 with its message, as for core routes. An API path that no route matches is a JSON 404, a page path a text 404. `routes/extensions.ts` asks the app's host at each request. `@reins/client` gives an extension's own client module `client.extension(name)` (`json`, `none`, `segment`), with paths after the prefix.

## What the SDK gives an extension

- **`db`**: the server's main database (the process's connection, read at each use). Built-in extensions keep their tables in the core's migrations. An installable extension cannot use the `bun:sqlite` `Database` type: it will need its own database (*Not built yet*).
- **`secrets`**: `encrypt`/`decrypt` with the server's key (AES-256-GCM, `crypto.ts`), the key the core keeps its credentials with. The extension stores the ciphertext where it likes (MCP: `mcp_server_secrets`).
- **`broadcast(message)`**: to every browser, as `{ type: "extension", extension: <name>, message }` (`ServerMessage`'s `extension` member; the frontend's `InboundMessage` has it too). The extension's frontend part tells its messages apart.
- **`logger`**: the server's log.

## Agents and `api.tools`

- **`api.tools.search(query, filters?)`** (`scripting/tools.ts`) returns documentation: each provider's matching tools as a TypeScript interface keyed by final ID (`toolSearchDocs`, `extensions/tool-docs.ts`), grouped by provider in the order of registration, with a `ToolResult` declaration. In each provider, the first 10 are documented and the others named. Without a query, a provider with more than 10 tools only names them. A provider's error is shown in its place. Results of different providers are not ranked against each other.
- **Matching** (`matchTools`, also `tools.match`): each word of the query is a substring of the ID and name (weight 10), title (5), argument names (3) or description (1). The tools that match every word, else, for several words, those that match the most. A plural word also matches its singular. A query that is a tool's ID or name (any case) puts that tool first. With the host's removal of the prefix, a query that is a tool's final ID, its local ID or its name (`mcp__vercel__list_deployments`, `vercel__list_deployments`, `list_deployments`) finds it first. An empty query keeps all.
- **Filters** are a plain object that the core gives to every provider without change (`{}` when none is given). Each provider decides what its keys mean, and what it does with keys it does not know. A provider tells agents its filters in its prompt section.
- **`api.tools.call(id, args?, timeoutMs?)`** takes the final ID and returns the `ToolResult` (a failure the tool reports is a result with `isError`), with the script's signal.
- **`search` lists API functions only** (the `api.tools` functions among them). It never lists the tools and never waits for an extension.

## Tests

`__tests__/extensions/host.test.ts` tests the host through a test extension (`helpers/test-extension.ts`: a provider of fixed tools that records its searches and calls) and `createAppState({ extensions })`: tool searches and calls through `execute`, scripting functions and `search`, routes, prompt sections, the database, broadcast and secrets, and the lifecycle. `__tests__/extensions/tool-docs.test.ts` tests the documentation and the matching. MCP's own tests are in `__tests__/extensions/mcp/` ([mcp-servers.md](mcp-servers.md) *Tests*).

## Not built yet

See [backend-extensions.md](../plans/completed/backend-extensions.md) *Not in this plan*: a loader (discovery, packages, manifests, building an extension while the server runs), a database and migrations for each extension, direct model tools, permissions, trust and sandboxing, versioning, and dependencies between extensions. A frontend extension also has no SDK capability for a Settings section, its own HTTP API or its own WebSocket messages yet ([reins-sdk.md](reins-sdk.md) *The MCP extension's frontend part*).

**Direct model tools and their names.** When tools are given to the model directly (not through `api.tools`), an extension tool may declare a short name with no prefix (`record_todo`, not `todos__record_todo`). The prefix is needed only because `api.tools` finds tools on demand, so the host has no list of names before a call. A direct tool must be declared before the session starts, because the model gets its definition in the request. So the host can keep a map from short name to owner, as bb and Pi do. It refuses a short name that a built-in tool or another extension already has, and shows that as a problem of the extension that registered second. It does not choose silently. The prefixed ID stays the tool's stable ID, so `api.tools.call` reaches it the same way.
