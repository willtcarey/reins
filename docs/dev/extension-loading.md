# Loading extensions

> New to the extension system? Read [extensions-overview.md](extensions-overview.md) first: the glossary and how the parts fit.

How Reins records its extensions, built in and added, turns each on or off, and loads and reloads those that live outside this repository, from the files their authors built ([ADR-038](../adr/038-added-extensions.md)). The author's guide (the manifest, the SDKs, the CLI, testing) is [building-extensions.md](../features/building-extensions.md); this doc is the host's side. The SDKs themselves: [server-sdk.md](server-sdk.md), [reins-sdk.md](reins-sdk.md).

## Where it lives

```
packages/sdk/                              # @reins/sdk (src/index.ts), @reins/sdk/server (src/server/index.ts) and @reins/sdk/lit: the SDK package, typechecked on its own (its tsconfig)
packages/backend/src/
  extensions-store.ts                      # the `extensions` table: rows, the switch, generation
  extension-system/                        # the system (extensions/ holds only the built-ins)
    extensions.ts                          #   Extensions: one record each (ExtensionState) and every operation:
                                           #     start (and loaded), add, reload, remove, setEnabled, reportFrontend, list, bundleFile, dispose
    manifest.ts                            #   readManifest: the `reins` key of package.json, checked (TypeBox), entries made absolute; SDK_VERSION
    package.ts                             #   openPackage(dir, name): manifest, build ID, files, frontend entry, file(path), importBackend();
                                           #     installPackage (the copy in Reins), openInstalled, removeBuilds
    backend.ts                             #   startBackend: storage → migrations → host.connect → register(sdk) → start()
    report.ts                              #   ExtensionView, ExtensionOrigin, describe(record, host)
    styles.ts                              #   scopeStyles: a stylesheet's rules applied only inside its extension's views (lightningcss)
    host.ts                                #   ExtensionHost: the boundary (connect, and what the server reads; server-sdk.md)
  extensions/built-in-names.ts             # BUILT_IN_EXTENSION_NAMES: every built-in, either part; BuiltInExtensionName
  routes/extensions.ts                     # /api/installed-extensions…, /extension-bundles/…
packages/frontend/index.html               # the import map: lit, lit/ → /dist/vendor/lit/
packages/frontend/src/
  vendor/build.ts                          # buildVendor: the libraries the app provides (Lit) into dist/vendor
  extension-system/                        # the same two roles as the server's (the scope's wrapper: sdk-host/create-sdk.ts)
    extensions.ts                          #   Extensions: the frontend parts the report says are on, activated and disposed
    host.ts                                #   ExtensionHost: activates one with its own SDK, keeps what it registered
  sdk-host/create-sdk.ts                   # sdkDisposers: what an extension's SDK made, which its disposal removes
packages/cli/src/extension.ts              # reins extension add | list | reload | remove | enable | disable
packages/sdk/src/lit/                      # @reins/sdk/lit: an extension's custom elements in its bundle's own registry
```

`extensions/` holds only the built-ins and their two lists: lint treats `extensions/<name>/` as a built-in extension (`reins/backend-extension-boundary`), so system code lives in `extension-system/`.

## The record

`extensions` (main database, core migration `065`) has a row for every extension: `name` (the key), `source_kind` (`'built-in'` or `'path'`; a git source would be another kind), `path` (absolute and unique for `'path'`, null for a built-in, checked), `enabled` (the user's switch, `1` first), `generation` (an added one's explicit reloads, `0` first) and `added_at`.

- **Built-in ones** are recorded the first time an app knows them (`start`, `INSERT OR IGNORE`, enabled), all of `BUILT_IN_EXTENSION_NAMES`: those with a backend part (`BUILT_IN_EXTENSIONS`) and those with only a frontend part (`sidebar-projects`, `file-viewer`, …), so those can be turned off too. Both sides' built-in lists are typed with `BuiltInExtensionName`, so a built-in missing from the names does not compile. A built-in's row is never deleted: it can be turned off, not removed (400).
- **Added ones** (`add`): it refuses a relative path, a path that is not a directory, a manifest it cannot read, a built-in's name (409), a name or directory already added (409). A failed load keeps the row, so the author fixes it and reloads. A manifest whose name changed fails at load (`manifest`), asking to remove and add it again.
- **A name clash** (a later Reins brings a built-in with the name of an extension the user added): the added one keeps the name, the built-in is not loaded, and an error says to remove the added one.

## Built files

The manifest's `backend`, `frontend` and `styles` name files the author built (for example `dist/server.js`, `dist/frontend.js`, `dist/styles.css`). Reins builds nothing and runs no command of the extension's (ADR-038); what it does to them happens when it installs them (*Styles*).

- **Checked at add** (`readManifest`): each entry inside the extension's directory. **At load**: each named file exists, else the extension fails at `load` with "Its <part> file <path> does not exist: build the extension first".
- **What a package is** (`files`): `package.json`, the backend file, the icon and every file of the frontend directory (the bundle's chunks, its styles, its fonts). Never its sources or `node_modules`, which is why the frontend file must be in a directory of its own (`dist/`), not at the package's root (`readManifest` refuses that).
- **Its build ID** (the first 16 hex characters of a sha256 of those files, path and content) is the `build.id` in the frontend's URLs, so a change to any file, a chunk too, is a new URL.
- **Installed: Reins loads a copy, not the author's directory.** `add` and `reload` copy the package into `<data dir>/extension-builds/<name>/<build ID>/` (`installPackage`: written aside, then renamed into place, so a half copy is never loaded; a build already there is used as it is), record the build in the row (`build_id`) and delete the extension's other copies. At each app's start and when it is turned on, it loads that copy (`openInstalled`), so it runs without its author's directory; a row with no copy yet (or one deleted by hand) is installed from the directory then. `remove` deletes the copies. They are not in `<data dir>/extensions/<name>/`, which is the extension's own `dataDir`.
- **The frontend directory of the copy** is what browsers may load: `/extension-bundles/<name>/<build ID>/<path>` serves any file under it of the current build, but never the backend file, nothing outside it and nothing of another build (`bundleFile`). A copy never changes, so files are served `Cache-Control: public, max-age=31536000, immutable`. A rebuild takes effect at the next reload.

## Styles

An added extension's stylesheet (the manifest's `styles`, in its frontend directory) is scoped when it is installed, and isolation goes one way: its CSS reaches only its views, the app's reaches them too (ADR-038).

- **At install** (`installPackage`), `scopeStyles` (`styles.ts`, with lightningcss) rewrites each selector of the sheet: `S` becomes `:where([data-reins-extension="<name>"]) S`, in layers and media queries too; a selector whose first compound has `:root`, `:host`, `html` or `body` has it replaced by the scope (a theme's variables are set on the scope's element and inherited); nested rules (`&`) are left, as their parent is scoped; `@keyframes`, `@font-face` and `@property` are left (they are global by nature). A sheet that `@import`s another, or cannot be parsed, fails the install (`load`). Only selectors are visited: lightningcss cannot read back every declaration it hands a visitor. The result is minified into `.reins/styles.css` in the copy, outside the frontend directory, so it is not part of the build ID; `INSTALL_VERSION` in the build ID changes when the processing does, so a copy made the old way is not reused.
- **Served** as `/extension-bundles/<name>/<build ID>/~styles.css` (`SCOPED_STYLES`; `~` keeps it apart from the author's files), and reported as `build.frontend.styles`.
- **In the browser**, `Extensions` links it (`addStyles`: a `<link>` in the head, awaited, so views never show unstyled; one that fails to load is logged) before the frontend part registers, and removes it after the part is disposed. The extension's SDK is made with its scope (`createReinsSdk(…, { scope })`): every mount it registers (a view's pane, its icon and toolbar, an inline view, a sidebar section, a Settings page) draws into a `display: contents` element with `SCOPE_ATTRIBUTE` (`@reins/sdk`), appended to Reins' target. Built-ins get no scope.
- `SCOPE_ATTRIBUTE` is the SDK's; the server's `styles.ts` has its own copy (the server imports nothing of the frontend SDK at runtime), which a test checks.

## Provided libraries

The app provides Lit to extensions' frontend parts, which leave it out of their bundles (`bun build … --external lit --external 'lit/*'`):

- **The import map** in `index.html` (before any module script, as a page's import map must be) maps `lit` to `/dist/vendor/lit/index.js` and the prefix `lit/` to `/dist/vendor/lit/`. It is static: what is provided is part of an SDK version, and extensions add no entries.
- **The vendor build** (`buildVendor`, `packages/frontend/src/vendor/build.ts`) builds each module of Lit's `exports` (not `polyfill-support.js`) into `dist/vendor/lit/<path>`, their shared code in chunks, so every extension gets one Lit. The frontend's `build` and `dev` scripts run it, and the dev supervisor before its bundle watcher. The app's own bundle keeps its own Lit: extensions' elements are in their own registries, so nothing needs one Lit instance with the app.
- **Not provided:** anything else. The backend bundles all it uses (an import map is a browser's; the host's TypeBox checks schemas from another copy, as `Kind` is a global symbol). Svelte is not provided: its compiled output depends on its runtime's minor version. React could be added the same way (one map entry and the vendor build), as could others, each a promise of the SDK version.

## Loading in the server

- **One state at a time.** Each record (`Extensions`, `extensions.ts`) has its `origin` (*Its origin*) and one `state` (`ExtensionState`): `loading`, `disabled`, `failed` (its stage, its message, and the storage and migrations it had, for the report) or `loaded` (its running backend part, or none: a frontend part only). The report's `status`, `failure` and `storage` all come from it (`describe`, report.ts). Turning one off or on and reloading it delete the record (`unload`) and make a new one: no state goes back.
- **The app's state starts them as it is created** (`createAppState` calls `Extensions.start`): the built-ins at once, the added ones in the background. Nothing else starts extensions; `server.ts` only disposes them when the app stops.
- **Built-in ones register at once**, in order: one turned off is recorded `disabled` and never starts, so its services never start; the others go to `loaded`, their backend part started (`startBackend`), or with none (only a frontend part: `backendPart: false`, nothing on the server, no data directory).
- **Added ones load at each app's start**, in the background, so importing them does not hold up the app, all at once (`Extensions.loaded` settles when they are in; tests await it): each is recorded `loading`, its installed copy is opened (`openInstalled`; installed from its directory when it has none) and its backend module imported (`importBackend`), then its origin is set whole and its backend part started. A `PackageFailure` (its stage, `manifest` or `load`, and the manifest once read) is recorded as its failure. One turned off is recorded `disabled` with its manifest, when it can be read. When all are done it broadcasts `extensions_changed`. A dev reload loads them again, evaluating each backend module anew.
- **Starting a backend part** (`startBackend`, backend.ts), built in or added: its directory and database (`ServerProcess.extensionData`), its pending migrations, a connection to the host (`ExtensionHost.connect`: its SDK object), its register function, then its services (`connection.start()`). A `BackendFailure` (`storage`, `migration` or `register`, with the storage it opened) fails the record; what a register function registered before it threw is removed. Its disposal is `connection.disconnect(its disposer)`: services stopped, its disposer awaited, all it registered removed.
- **Importing** (package.ts): the backend file is imported as `<file>?load=<unique>` (a new module instance at each load) and its default export checked: `{ register, migrations? }`, each migration `{ id, up }`. It is wrapped (a register function that returns nothing gets a no-op disposer). An extension whose manifest names no backend file has no backend part: it is `loaded` with no storage and no data directory.
- **Its origin** (`ExtensionOrigin`): `source` (`{ kind: "built-in" }` or `{ kind: "path", path }`), `manifest` (`label`, `description`, `version`, `icon` SVG), `build` (`id`, the files' hash, and `frontend: { script }`, its URL with `?g=<generation>`) and `backendPart`. `ExtensionView` (`GET /api/installed-extensions`, one for every row) carries them, its `status` gains `loading` and `disabled`, and its `failure.stage` gains `manifest` and `load` (a named file is missing, or the backend module could not be imported or is not an extension).
- **Turning one on or off** (`setEnabled(name, enabled)`, `PATCH /api/installed-extensions/:name` `{ enabled }`, any row): sets `enabled`, unloads it, then records it `disabled`, or registers it again (a built-in's backend part or `null`, an added one loaded from its files), and broadcasts. It stays as it is in the next apps. An added one turned off cannot be reloaded (409).
- **Reload** (`reload(name)`): bumps `generation`, unloads it (its backend part disposed, its record deleted, its package forgotten, so its bundle files are no longer served), then installs its files again from its directory and loads the copy, and broadcasts. **Remove**: unloads it, deletes the row and its copies, broadcasts; its data directory, database and secrets stay. Operations on one extension run one after another (`serial`).
- **A load that ends late** records and registers nothing: after the app stopped (`Extensions.dispose`, which waits for the start's loads before it stops anything), or after the extension was unloaded while it loaded.
- **Bundles:** `GET /extension-bundles/:name/:hash/*` (*Built files*); anything else is a text 404. Outside `/api`, before the static files.

## In the browser

- `app-shell` creates `Extensions` over `AppStore.extensionHost`, `createReinsSdk` and `BUILT_IN_EXTENSIONS`. On each connect and each `extensions_changed`, it reads `GET /api/installed-extensions` and calls `sync(report)`. So the built-in parts too wait for the first report; without one (the request failed) it syncs an empty report, which turns every built-in part on, and the next report turns off what is off.
- **`sync`** (one at a time, in order) wants, first, each built-in part unless the report has it `disabled` or gives its name to an added extension (a report without it is of a server that does not record it: on), then each added extension with `status === "loaded"` and a `build.frontend`. It disposes what is active and not wanted as it is (turned off, gone, or another script URL: another build or generation), then activates what is wanted and not active, in that order. An added part imports the script (`import(url)`) and activates its default export with `Extensions.activate` and an SDK of its own, labelled from the manifest, its icon the manifest's SVG. An import that fails, a default export that is not a function, or a name the app keeps for its own SDKs (`app`, `file-browser`) is recorded as a failed activation with why. A built-in part turned on again is activated after the others, so it comes last in what is listed in registration order (the sidebar keeps the user's order).
- **Each browser reports how an added part loaded** (`report`, `POST /api/installed-extensions/:name/frontend` `{ script, error }`): null once it activated, else the error's name, message and first stack frames (a failed import or a register function that threw). The server keeps the latest on the extension's record (`ExtensionHost.reportFrontend`), only for its current script (a browser on an older build changes nothing), logs a failure, and gives it as `ExtensionView.frontendFailure`; a browser that loads the part clears it, and a reload or the next app starts without one. So a failure in one browser (a phone, a page on plain http) can be read from the server: `reins extension list`, Settings, `GET /api/installed-extensions`.
- **Disposal removes everything:** `createReinsSdk` records the disposer of every registration and listener made through each SDK (`sdkDisposers(sdk)`), and `ExtensionHost.activate`'s disposer runs the extension's own and then all of those; a register function that throws keeps nothing either. This holds for built-ins too.
- **Settings → Extensions** reads the report again on `extensions_changed` once loaded (`ExtensionsStore`, given the app's socket and the built-in parts, which label one turned off), shows each extension's status (`disabled` with a grey dot), source and version, Turn off or Turn on for every one, and for an added one Reload (while it is on) and Remove (`@reins/client`'s `installedExtensions`).

## CLI

`packages/cli/src/extension.ts`: `add <path>` (resolved against the working directory; exit 1 when it was added but failed, with `reins extension reload <name>` as the next step), `list` (every extension: `name`, `status`, the path or `built in`, and under it why it failed: its stage, or a browser's report), `reload <name>`, `remove <name>`, `enable <name>`, `disable <name>`. There is no `new`: an agent sets an extension up from the guide (building-extensions.md *Set up an extension*: requirements and steps). Which server: `server.ts` (`--server`, else a paired node's server, else the local one; `--local` for the local one on a paired machine).

## Tests

Each module of the system has one test file, at its public boundary:

| File | Tests |
|---|---|
| `backend/…/extension-system/extensions.test.ts` | `Extensions` through the routes, grouped by operation: adding one, loading at each app's start, reloading, turning one off and on, removing one, built-ins, the browser's report. Built files are written as an author's build would (one fixture is bundled with `bun build`). |
| `backend/…/extension-system/package.test.ts` | `openPackage` on a temporary directory: build ID, frontend entry, only the frontend directory's files, failures with their stage. |
| `backend/…/extension-system/styles.test.ts` | `scopeStyles`: rules in layers and media, the page's roots, nested rules, keyframes and font faces, the refusals; the attribute is the SDK's. |
| `backend/…/extension-system/backend.test.ts` | `startBackend`: the order (migrations, register, services), disposal, and each failure stage. |
| `backend/…/extension-system/host.test.ts` | `ExtensionHost`: what each kind of registration does, and how the core reads it. |
| `frontend/…/extension-system/extensions.test.ts` | The browser's `Extensions.sync`: once per build, replaced, disposed when turned off, failures reported, built-ins first; an added extension's scope and stylesheet. |
| `frontend/…/extension-system/host.test.ts` | The browser's `ExtensionHost`: disposal removes what the extension forgot. |
| `frontend/…/models/stores/extensions-store.test.ts`, `components/settings/extensions-section.test.ts` | Settings: the cards, the details page, the switch, reload and remove. |
| `frontend/…/vendor/build.test.ts` | Every public Lit module in the import map is a module the vendor build wrote. |
| `cli/src/extension.test.ts` | Each command against a stand-in server. |
| `scripts/__tests__/extension-guide.test.ts` | The guide's version table (Lit, TypeBox, Tailwind) is the app's installed versions. |

The test helper's `createAppState` makes the given `extensions` the only built-ins unless `builtInNames` names more.

## Not built yet

Git sources (`source_kind`, a clone installed as a directory is, a ref, updates) and distributed packages; node parts (the manifest's `node`); adding from Settings (the CLI adds); watching an extension's `dist/` to reload by itself; React or other provided libraries; a test harness for authors (`@reins/sdk/testing`: a fake server SDK, as Spoke's `test/fake-reins.ts`); a stable SDK compatibility promise (the `sdk` range is checked, but the SDK changes with Reins); pruning old backend module instances (each load stays in memory until a restart).
