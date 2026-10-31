# Backend Extensions

Status: **planned**.

## Goal

The backend gets the same seam as the frontend's Reins SDK ([reins-sdk.md](../dev/reins-sdk.md), ADR-030): a server SDK that the server builds over the app state and gives to the register functions of built-in extensions. MCP servers become the first backend extension. Then a second tool source (an integration, the project's `.mcp.json`, a pinned plugin app) does not add its own namespace, prompt code, `AppState` field and routes to the core.

Later, an extension will be installed, or built while the server runs, and the server will load it. This plan does not build that loader. But the seam must not make the loader harder: an extension uses only what its register function gets.

## Why

The MCP work ([mcp-servers.md](../dev/mcp-servers.md)) is wired into the core in many places:

- `api.mcp.tools` and `api.mcp.call` are a namespace of their own (`scripting/mcp.ts`, `scripting/mcp-tool-docs.ts`).
- `system-prompt.ts` has `mcpServersSection`, and `SessionKindContext` has `mcpServers`. `SessionModel.context` reads the MCP store.
- `AppState.mcp` is an `McpConnections`. `state.ts` publishes MCP changes, and `server.ts` closes the connections.
- `Models.mcpServers`, the `mcp_server_*` broadcasts, `routes/mcp-servers.ts`, and the MCP paths in `api-paths.ts`.

extension-architecture.md asks that a capability be given through a Reins-owned seam, and that the built-in use that seam. Here the capability is "tools for agents, from a source outside Reins".

## Names

- **Extension**: code that contributes to Reins only through an SDK. This is the frontend's meaning: `packages/frontend/src/extensions/` holds built-in extensions (`compact-command`, `message-file-references`). An extension can have a frontend part and a backend part.
- **Server SDK**: what a backend extension's register function gets. The frontend's SDK is `@reins/sdk`; the server's is `@reins/sdk/server` (a `tsconfig` alias at first, as `@reins/sdk` is).
- **Built-in extension**: an extension in the Reins repository, registered by the server at startup. MCP is one.

## Layout

```
packages/backend/src/
  extensions/                  # the host: the registry, the server SDK, api.tools
    mcp/                       # everything MCP: store, connections, OAuth, models, routes, tool docs, api.mcp
  sdk/server/index.ts          # @reins/sdk/server: types only, imports only its own modules
packages/frontend/src/extensions/mcp/   # the Settings section and its store
```

**The boundary rule:** nothing outside `extensions/mcp/` imports from it, except the one line that registers it. `extensions/mcp/` imports only `@reins/sdk/server` and its own modules (and npm packages, such as `@modelcontextprotocol/sdk`). A lint rule enforces both, as `reins/features-through-sdk` does in the frontend. The rule shows when the SDK is not complete: each exception is a capability to add to the SDK.

## What an extension contributes

A register function, `registerMcp(reins)`, gets the server SDK and returns a disposer. The server calls it each time it builds an app (`createAppState`), and calls the disposer when the app stops (`server.ts`). A hot reload thus registers the extension again on its new code. That is the first part of "the server loads new code".

1. **Tools** (`reins.tools.register(source)`). A tool source has:
   - `search(query, { filters, signal }) → Tool[]`: its tools that match the query and the filters (*Agents and `api.tools`*). A `Tool` is `{ id, name, title?, description?, inputSchema, outputSchema?, annotations? }` (JSON Schema for the schemas: a standard, not an MCP type).
   - `call(id, args, { signal, timeoutMs }) → ToolResult`, or a "not mine" answer for an ID that it does not own (it can be async). A source gives the "not mine" answer without running anything.
   - **IDs belong to the extension.** The core adds no prefix and does not parse them. IDs must be unique and stable: the extension makes them so. A duplicate ID is the extension's error: the core does not look for one, and the first registered source wins. MCP uses `<server>__<tool>`, in `[a-zA-Z0-9_-]`, at most 64 characters, so that the same IDs can become direct model tools later (*Not in this plan*).
   - **The core keeps no map of IDs.** Search asks the sources at the time of the search. A call asks them at the time of the call, one after another in the order of registration: the first source that claims the ID runs it, and the core asks no more sources. If no source claims it, the call fails as an unknown tool. MCP resolves `<server>__<tool>` from its store without a connection.
2. **A system prompt section** (`reins.prompt.register(contribution)`). The contribution gets the session (and its task) and returns text, or nothing. MCP gives the enabled servers with their instructions. The core puts the sections after the Reins section, in the order of registration. It reads them when a session's runtime opens, as it does now.
3. **HTTP routes** (`reins.routes`), mounted under `/api/extensions/<extension>/…`, and a page route outside `/api` for an OAuth callback (`/extensions/<extension>/…`). MCP's routes move there. `@reins/client` gets them through the extension's own client module.
4. **Scripting functions** (`reins.scripting.register(functions)`): an extension's own `api.<namespace>`, for what is not a tool. MCP keeps `api.mcp` for its management (`list`, `add`, `update`, `remove`, `test`, `signIn`, `finishSignIn`, `signOut`). `api.mcp.tools` and `api.mcp.call` go.
5. **Lifecycle.** What the register function starts (MCP's `McpConnections` and its refresh timer), the disposer stops. The core keeps no field for it: `AppState.mcp` goes.

## What the server SDK gives an extension

- **The database**, for built-in extensions: the main database, as now. MCP's tables stay in `migrations.ts` for now. An installable extension will need its own database and migrations. That comes with the loader, not here. Built-in extensions can stay in the main database, or move then.
- **Secrets**: an encrypted store owned by the host (AES-GCM, as `crypto.ts` does now). MCP keeps `mcp_server_secrets`, but it reads and writes through the SDK and no longer imports `crypto.ts`.
- **Broadcast** to browsers, for events of the extension (`mcp_server_updated`, `mcp_server_removed`). The core's `Broadcast` union then does not name MCP types.
- **A logger.**
- **The origin of a request**, for callback URLs (`requestOrigin`).

## Agents and `api.tools`

- **`api.tools.search(query, filters?)`** returns documentation, as `api.mcp.tools` does now: the matching tools as TypeScript interfaces. The core renders it from the `Tool` values (`mcp-tool-docs.ts` becomes core code: it renders JSON Schema, and nothing in it is MCP). Results are grouped by tool source and are not ranked against each other.
- **`api.tools.call(id, args, timeoutMs?)`** returns the `ToolResult`, with `ctx.signal`.
- **`search` stays separate.** It lists API functions only, and never waits for an extension.
- **Filters.** `filters` is a plain object that the core gives to every tool source without change. Each source decides what to do with it, also with keys that it does not know: the core makes no rule. An extension tells agents its filters in its system prompt section. MCP has one tool source and the filter `{ server: "vercel" }`, so an agent can limit a lookup to one server, as `api.mcp.tools(server, query)` does now. This matters for a server with hundreds of tools.

## Decisions

These are the decisions made when this plan was written, and the options rejected:

- **The server SDK follows the frontend's model (ADR-030)**: register functions and a disposer. A "provider" interface for tools only was rejected: the next contribution (routes, prompt, UI) would need a second seam.
- **Tool IDs belong to the extension, and the core asks the sources.** A source's `call` runs the tool or answers "not mine"; the core asks the sources in the order of registration and stops at the first that claims the ID. A separate `owns(id)` step, so that the core could refuse an ID that two sources claim, was rejected: IDs must be unique, and a duplicate is the extension's error. A prefix that the core parses (`mcp:<server>/<tool>`) was rejected: it forces one format on every extension, and `:` and `/` are not permitted in model tool names. A map of IDs in the core, filled by searches, was rejected: it fails for an ID from before a reload or from an earlier run.
- **`search` stays separate from `api.tools.search`.** Hundreds of tools from one server would push out the API functions, and `search` would wait for slow servers.
- **Search filters are opaque to the core.** One tool source per MCP server was rejected: the extension knows how its tools are grouped, and the core does not need to.
- **Built-in extensions keep the main database.** Splitting MCP's tables out gives nothing until there is a loader.
- **Consequences:** `api.mcp.tools` and `api.mcp.call` go (`api.mcp` keeps management). MCP's routes move to `/api/extensions/mcp/…`, so the OAuth callback URL changes, and servers that registered a client for the old URL register again at the next sign-in.

## Steps

Each step is one or more commits, with the suite, typecheck and lint passing.

1. **The server SDK and the registry**, with `tools`, `prompt`, `scripting`, `routes` and the lifecycle, and `api.tools.search`/`call`. Tests use a test extension (a source of fixed tools), not MCP.
2. **Move MCP into `extensions/mcp/`**, registered through the SDK: the store, connections, OAuth, models, routes and `api.mcp` management. Remove `AppState.mcp`, `Models.mcpServers`, `mcpServersSection`, `SessionKindContext.mcpServers` and the MCP members of `Broadcast`.
3. **Change MCP tools to `api.tools`**: MCP's tool source(s), the IDs, the prompt text. Remove `api.mcp.tools` and `api.mcp.call`.
4. **Secrets and broadcast through the SDK.**
5. **The frontend part**: move the Settings section and its store into `packages/frontend/src/extensions/mcp/`. It still uses app code where the frontend SDK has no capability for it (a Settings section): record each such use, as reins-sdk.md does for the diff file tree.
6. **The lint rule** for the boundary, and the docs: mcp-servers.md, extension-architecture.md *Open design work*, a `docs/dev/server-sdk.md`, and backend-architecture.md.

## Not in this plan

- **A loader**: discovery, packages, manifests, building an extension while the server runs.
- **A database for each extension**, and an extension's own migrations. A known gap until then: `reins.db` exposes the `bun:sqlite` `Database` type, which an installable extension will not be able to use.
- **Direct model tools ("eager tools")**: tools given to the model as tool definitions, not through `execute`. The IDs are already in the format they need.
- **Permissions, trust and sandboxing.** As in the frontend, this is a boundary between modules, not a security boundary.
- **Versioning** of the server SDK.
- **Dependencies between extensions.**
