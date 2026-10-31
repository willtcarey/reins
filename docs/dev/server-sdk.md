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

- **Tools** (`tools.register(provider)`). A `ToolProvider` has a `title`, `search(query, { filters, signal }) → Tool[]` and `call(id, args, { signal, timeoutMs }) → ToolResult | null` (null: "not mine", given without running anything). A `Tool` is `{ id, name, title?, description?, inputSchema, outputSchema?, annotations? }`, with JSON Schema. `tools.match(query, tools)` ranks as the core does (*Agents and `api.tools`*).
  - **IDs belong to the extension.** The core adds no prefix, does not parse them and keeps no map of them. IDs must be unique and stable (`[a-zA-Z0-9_-]`, at most 64 characters, so that they can also be model tool names later). A duplicate is the extension's error.
  - **The core asks the providers at each search and each call.** A search asks all of them at the same time. A provider that throws is shown in its place, and the others still answer. A call asks them one after another, in the order of registration: the first that claims the ID runs it, and no other provider is asked. If none claims it: `UnknownToolError`.
- **System prompt sections** (`prompt.register(contribution)`). A contribution gets a `PromptContext` (`session` `{ id, projectId, taskId }`, its `task`, and the `tools` the model is offered, null for every tool) and returns text or null, possibly async. The core asks when a session's runtime opens (`SessionModel.context`, through `App.promptSections` of the current app). Only the Reins agent kind gets the sections: they follow the whole Reins section (task included), in the order of registration. A throw is reported, and the session opens without that section.
- **Scripting functions** (`scripting.register({ functions, types? })`): an extension's own `api.<namespace>` in `execute`, documented by `search`. A `ScriptFunction` is the core's `defineFunction` shape with JSON Schema (`parameters` must be an object schema; its properties are the positional arguments). `execute` gets the params and a `ScriptContext` (`sessionId`, `projectId`, `taskId`, `signal`). `types` are named schemas that `search` shows by name. A registration's functions share one namespace, which must not be a core namespace or another registration's (that throws). `scriptingApi(extensions)` (`scripting/api-registry.ts`) gives the core's functions and types plus the extensions'. `runScript` and `search` use it.
- **HTTP routes** (`routes.api.get/post/put/patch/delete(path, handler)` under `/api/extensions/<name>`, `routes.pages.…` under `/extensions/<name>`, `routes.pagePath(path)` for a page's path from the root). A handler gets a `RouteRequest` (`req`, `url`, decoded `params`, `origin`: the origin the browser used, from `X-Forwarded-*`, for callback URLs) and returns a `Response`. A throw is logged and answered 500 with its message, as for core routes. An API path that no route matches is a JSON 404, a page path a text 404. `routes/extensions.ts` asks the app's host at each request. `@reins/client` gives an extension's own client module `client.extension(name)` (`json`, `none`, `segment`), with paths after the prefix.

## What the SDK gives an extension

- **`db`**: the server's main database (the process's connection, read at each use). Built-in extensions keep their tables in the core's migrations. An installable extension cannot use the `bun:sqlite` `Database` type: it will need its own database (*Not built yet*).
- **`secrets`**: `encrypt`/`decrypt` with the server's key (AES-256-GCM, `crypto.ts`), the key the core keeps its credentials with. The extension stores the ciphertext where it likes (MCP: `mcp_server_secrets`).
- **`broadcast(message)`**: to every browser, as `{ type: "extension", extension: <name>, message }` (`ServerMessage`'s `extension` member; the frontend's `InboundMessage` has it too). The extension's frontend part tells its messages apart.
- **`logger`**: the server's log.

## Agents and `api.tools`

- **`api.tools.search(query, filters?)`** (`scripting/tools.ts`) returns documentation: each provider's matching tools as a TypeScript interface keyed by ID (`toolSearchDocs`, `extensions/tool-docs.ts`), grouped by provider in the order of registration, with a `ToolResult` declaration. In each provider, the first 10 are documented and the others named. Without a query, a provider with more than 10 tools only names them. A provider's error is shown in its place. Results of different providers are not ranked against each other.
- **Matching** (`matchTools`, also `tools.match`): each word of the query is a substring of the ID and name (weight 10), title (5), argument names (3) or description (1). The tools that match every word, else, for several words, those that match the most. A plural word also matches its singular. An empty query keeps all.
- **Filters** are a plain object that the core gives to every provider without change (`{}` when none is given). Each provider decides what its keys mean, and what it does with keys it does not know. A provider tells agents its filters in its prompt section.
- **`api.tools.call(id, args?, timeoutMs?)`** returns the `ToolResult` (a failure the tool reports is a result with `isError`), with the script's signal.
- **`search` lists API functions only** (the `api.tools` functions among them). It never lists the tools and never waits for an extension.

## Tests

`__tests__/extensions/host.test.ts` tests the host through a test extension (`helpers/test-extension.ts`: a provider of fixed tools that records its searches and calls) and `createAppState({ extensions })`: tool searches and calls through `execute`, scripting functions and `search`, routes, prompt sections, the database, broadcast and secrets, and the lifecycle. `__tests__/extensions/tool-docs.test.ts` tests the documentation and the matching. MCP's own tests are in `__tests__/extensions/mcp/` ([mcp-servers.md](mcp-servers.md) *Tests*).

## Not built yet

See [backend-extensions.md](../plans/completed/backend-extensions.md) *Not in this plan*: a loader (discovery, packages, manifests, building an extension while the server runs), a database and migrations for each extension, direct model tools, permissions, trust and sandboxing, versioning, and dependencies between extensions. A frontend extension also has no SDK capability for a Settings section, its own HTTP API or its own WebSocket messages yet ([reins-sdk.md](reins-sdk.md) *The MCP extension's frontend part*).
