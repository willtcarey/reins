# Extensions: the overview

Start here to learn how Reins' extension system is put together. This page names the parts and shows how they connect; each section links to the document with the details.

## Glossary

Use these words, and only these, in code, docs and messages.

| Word | Means |
|---|---|
| **extension** | A named unit that adds to Reins only through the SDKs. It has a backend part, a frontend part, or both. |
| **built-in extension** | One that ships inside Reins (`mcp`, `automations`, the file viewer, …). It can be turned off, not removed. |
| **added extension** | One the user added from a directory on the server's disk (`reins extension add <dir>`). Never "external" or "plugin". |
| **installed extensions** | Every extension this Reins has, built in or added: what Settings → Extensions lists and `/api/installed-extensions` manages. |
| **backend part** | The code the server runs: `{ migrations?, register(reins) }` (`ServerExtension`). A built-in's is a `BuiltInBackendPart`, an added one's is its `dist/server.js`. |
| **frontend part** | The code the browser runs: a register function given a `ReinsSdk`. A built-in's is an `ExtensionRegistration`, an added one's is its frontend script. |
| **package** | An added extension's directory as its author built it: `package.json` with the **manifest** (its `reins` key) and the built files it names. Reins builds nothing. |
| **scope** | The element (`data-reins-extension="<name>"`) each of an added extension's views is mounted in; Reins scopes its stylesheet to it at install, so its CSS reaches only its views. |
| **installed copy** | The package's built files, which Reins copies into `<data dir>/extension-builds/<name>/<build ID>/` at add and reload, and always loads from. |
| **build ID** | A hash of every file of a package; bundle URLs contain it, so a new build is a new URL, and a copy's files can be cached for good. |
| **generation** | A counter bumped at each reload, so browsers import the frontend part again even when the build did not change. |
| **record** | What the server knows of one installed extension in this app: its origin and its one **state**. |
| **state** | `loading`, `disabled`, `failed` or `loaded`. A state never goes back: a change deletes the record and makes a new one. |
| **report** | The server's view of every record (`ExtensionView[]`, `GET /api/installed-extensions`): what Settings, the CLI and browsers read. |
| **host** | The boundary between extension instances and the app (`ExtensionHost`). It gives each instance its SDK and keeps what it registered. |
| **registration** | One thing an extension registered through its SDK: a tool, an HTTP method, a view, a service… The host keeps each under the extension's name. |

## The shape

Each side, server and browser, has the same two roles:

| Role | Server | Browser |
|---|---|---|
| **`Extensions`**: decides which extensions run, owns their lifecycle | `backend/src/extension-system/extensions.ts` | `frontend/src/extension-system/extensions.ts` |
| **`ExtensionHost`**: the boundary; each instance's SDK and registrations | `backend/src/extension-system/host.ts` | `frontend/src/extension-system/host.ts` |

The rest of Reins (the core) reads extensions only through a host: `reins.tools` and `reins.images`, script functions in `execute`, prompt sections, HTTP routes, views and commands. An extension sees only its SDK object.

```
          the extensions table (extensions-store.ts): which exist, which are on
                                   │
   server  Extensions ── openPackage (package.ts) ── startBackend (backend.ts) ── ExtensionHost ⇄ backend parts
              │  report (report.ts)                                                   ▲
              ▼                                                                       │ the core reads
          /api/installed-extensions ──▶ Settings, the CLI                             │
              │
   browser    ▼  the report
           Extensions.sync(report) ── import(frontend script) ── ExtensionHost ⇄ frontend parts
                                                                     ▲
                                                                     │ the app reads (views, commands, sidebar…)
```

## Walk-through: adding Spoke

1. `reins extension add ~/Workspaces/spoke-reins` asks the server (`POST /api/installed-extensions`). `Extensions.add` reads the manifest, checks the name, and inserts a row (`source_kind = path`, enabled).
2. It installs and loads the extension: a record in `loading`; `openPackage` hashes the built files (the build ID), `installPackage` copies them into `extension-builds/spoke/<build ID>/`, and Reins imports `dist/server.js` from the copy.
3. `startBackend` opens Spoke's own directory and database, applies its migrations, connects it to the host (its SDK object), calls its `register(reins)`, then starts its services. The record is now `loaded`.
4. The server broadcasts `extensions_changed`. Each browser reads the report again; its `Extensions.sync` sees Spoke's frontend script (`/extension-bundles/spoke/<build ID>/frontend.js?g=<generation>`), imports it, and activates it with its own SDK. It tells the server how that went (`POST /api/installed-extensions/spoke/frontend`).
5. Spoke's sidebar section and pages appear, each mounted in a `spoke` scope, where its stylesheet (scoped at install, linked before it registers) applies. Its frontend part calls its backend part through `reins.http.call`, which is `POST /api/extensions/spoke/<method>`.

Reload, turn off and turn on follow the same steps: the record is deleted, its backend part disposed (services stopped, everything it registered removed), and a new record made.

## Where the details are

| Topic | Document |
|---|---|
| Why the system is built this way: seams, built-ins on the same path | [extension-architecture.md](extension-architecture.md) |
| The decision to load added extensions, and the alternatives rejected | [ADR-038](../adr/038-added-extensions.md) |
| The server SDK: what a backend part can register, its storage, services, the report's fields | [server-sdk.md](server-sdk.md) |
| The Reins SDK: what a frontend part can register, the browser host | [reins-sdk.md](reins-sdk.md) |
| Records, states, operations, packages, bundles, the browser's sync | [extension-loading.md](extension-loading.md) |
| Writing an extension (for authors) | [building-extensions.md](../features/building-extensions.md) |
| Settings → Extensions and the CLI (for users) | [extensions.md](../features/extensions.md) |
