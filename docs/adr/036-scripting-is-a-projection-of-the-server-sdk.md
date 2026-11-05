# ADR-036: Scripting is a projection of the server SDK

- **Status:** Accepted
- **Date:** 2026-11-05
- **Author:** Will (with Claude)

## Context

Agents script Reins through `execute`, whose `api` was a registry of scripting functions (`scripting/`, each made with `defineFunction`: a TypeBox schema, a description, tags and an `execute` scoped to the caller's session). Backend extensions got the server SDK (`@reins/sdk/server`, [server-sdk.md](../dev/server-sdk.md)), whose capabilities were classes of their own (`ExtensionSessions`, `ExtensionNodes`, `ExtensionProjects`, `ExtensionTasks`, images) over the same models.

The two layers did the same things twice and had drifted apart. The SDK could register tool providers but not search or call tools, so an extension could not use MCP servers or another extension's tools, which it needs before it can build apps. Scripts had `tools.search` and `tools.call` but not `contextUsage`; the SDK's sessions had `start({ prompt, … })` and `archivedAt`, scripts' `start(prompt, options)` with flat model fields and snake_case rows (`project_id`, `source_id`); reads were synchronous for scripts and asynchronous for extensions. Each new capability had to be written, checked and documented twice, and each fix applied twice.

## Decision

- **One capability layer: the server SDK.** Each capability is implemented once, as SDK methods over the models, in `sdk-host/` (`tools`, `sessions`, `tasks`, `projects`, `nodes`, `images`, `ui`, `models`, `reviews`). The scripting modules and the extension adapter classes are deleted.
- **Scripts' `reins` (formerly `api`) is the SDK bound to a caller.** A method runs with a `CallContext` whose `Caller` is the agent's session (a script: its defaults are the session's, `"current"` IDs name it, what it sends is a session update from it, the script's signal ends its calls) or the extension (it names what a script leaves out, `"current"` is refused, what it starts and sends records it). Same methods, same fields, same errors.
- **Declared once.** A method callable from scripts is a `ScriptMethod` (`@reins/sdk/server`): its description, its positional `params` (`{ name, schema, optional? }`, TypeBox schemas), its `returns` schema and its tags, beside `run`, its implementation. `sdkMethod` types `run`'s arguments by the params and its result by `returns` (the evolution of `defineFunction`). `search`'s documentation and scripts' argument checks come from the same declaration; the SDK's hand-written interfaces are checked against the bound methods at compile time.
- **Not everything is for scripts.** Only declared methods are projected: `services`, `http`, `prompt`, `db`, `secrets`, `broadcast`, registrations and settlement listeners stay extensions' only. A field or trailing option an extension may give and a script may not (`signal`, `background`, `metadata`) is marked `scripts: false` in its schema: `search` leaves it out and a script that gives it is refused.
- **Scripts' arguments are checked** against the declared schemas before the call, and an object takes no field its schema does not have, so a renamed or misspelt option fails with its name rather than being ignored.
- **Extensions call tools.** `reins.tools.search(query, { filters?, signal? })` and `reins.tools.call(id, args?, { timeoutMs?, signal? })` are `reins.tools`' operations. An extension gets the matching tools as data; a script gets them as TypeScript documentation (`toScript`).
- **Async everywhere**, for both callers.
- **One name.** A script's object is `reins`, as an extension's is, so a call reads the same in a script and in an extension (`reins.tasks.list()`). The namespaces are not globals of the script: agents name their variables `tasks` and `sessions`.
- **camelCase fields in one go**, the SDK's, for scripts too (`projectId`, `createdAt`, `model: { provider, modelId, thinkingLevel }`), with `pinned` and `archived` as booleans for both (the SDK's `archivedAt` went), and the Reins system prompt and docs updated. `"current"` IDs keep working for scripts.
- **Extensions' own script namespaces** (`reins.scripting.register`, MCP's `reins.mcp`, automations') are `ScriptNamespace`s, the declaration the core uses, with a `ScriptContext` for their `run`.

## Rejected

- **Keeping two layers and sharing helpers between them.** Smaller steps, but each capability would still have two interfaces to keep in agreement, and the drift came from exactly that.
- **Building scripts' object by hand over the SDK objects (a thin adapter per method).** It removes the duplicated logic but not the duplicated declarations: schemas and documentation would sit apart from the methods they describe and drift again.
- **Generating the SDK's TypeScript interfaces from the schemas.** The SDK is a types-only module that imports nothing (it is to become a package), and its interfaces carry what a schema cannot (an `AbortSignal`, a listener, the extension-only methods). Checking the bound methods against the interfaces at compile time keeps them in agreement without that.
- **Leaving the old snake_case names for scripts, or accepting both.** The workflow adds no compatibility layers (two names per field) unless asked; agents read the new names from `search`, and an old name now fails with the right one listed.
- **A script's `reins.tools.search(query, filters)` with the filters as the second argument**, which the MCP prompt used. Extensions need a `signal` there too; `{ filters }` keeps one options argument for both callers.

## Consequences

- Every agent's `api.*` call becomes `reins.*`: the system prompt, the tools' descriptions, `search` and the docs say `reins`. Sessions whose prompt predates the rename find the new name with `search`.
- A new capability is one `sdkMethod` in `sdk-host/`, added to `CORE_NAMESPACES`; scripts, `search` and extensions get it at once. An extension-only addition is an SDK interface member that is not declared.
- Extensions gained what scripts had: tools, sessions' `list` by project, `entries`, `wait`, `setModel` and the setters, tasks and projects writes, nodes' files and `list`/`get`/`reload`, images, ui, models. Scripts gained `sessions.contextUsage`, hidden message blocks and `sessions.list`'s `offset`.
- Scripts that relied on synchronous reads, snake_case fields, `send`'s `{ sessionId }`, flat `modelProvider`/`modelId` or `compact(sessionId, instructions)` fail with a clear message; the docs and system prompt show the new forms. Sessions whose system prompt predates the change keep its old MCP example until they reopen.
- `reviews` and `ui.openFile` need a session: an extension is refused reviews, and names the session for `openFile`.
- The frontend's Reins SDK (`SdkSessions`) still has `compact(sessionId, instructions?)`, where `reins.sessions.compact` now takes `{ instructions }`.
- Details: [server-sdk.md](../dev/server-sdk.md) *One layer*, [features/scripting.md](../features/scripting.md).
