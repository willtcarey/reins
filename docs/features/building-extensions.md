# Building extensions

An **extension** adds to Reins from outside it: a directory with a `package.json` and the files you built, which Reins loads. Reins builds nothing: you build your extension with any tools you like (Bun, Vite, Svelte, Tailwind), and its manifest names the results. It can give agents tools and script functions, run background services, keep its own database and secrets, answer HTTP calls, and add sidebar sections, pages, views, commands and a Settings page to the app. Reins' own features (MCP servers, automations, Recent sessions…) are extensions too ([extensions.md](extensions.md)); an extension you build uses the same two SDKs.

This guide is for a person, or an agent helping one, writing an extension: *Set up an extension* says what Reins requires and the steps to follow.

**Trust:** an extension runs inside the Reins server and inside the browser with their full authority (it can run commands on nodes, read Reins' data, and see what the page sees). Add only code you trust.

## Set up an extension

You write and build the extension; Reins builds nothing. It copies the files you built and loads the copy. Work in a new directory outside the Reins checkout.

### Requirements

**The package**

- `package.json` has `"type": "module"` and a `reins` key, the manifest (*The manifest*). Reins refuses a manifest with a key the table does not list.
- `reins.name` is the extension's name. The package's own `name` can be anything: Reins does not read it.
- Use these versions of the libraries an extension shares with the app (a test keeps this table equal to the app's):

<!-- versions -->
| Package | Version | Why |
|---|---|---|
| `lit` | 3.3.2 | The page gives this Lit to your frontend part: do not use a newer API. |
| `@sinclair/typebox` | 0.34.48 | Reins checks your HTTP schemas with its own TypeBox. |
| `tailwindcss`, `@tailwindcss/cli` | 4.1.18 | Only if you use Tailwind. The app's classes also apply in your views, so a class of the same name must have the same rules. |
<!-- /versions -->

- `@reins/sdk` gives the types of both SDKs and `@reins/sdk/lit`. It is not published yet: depend on it as `file:<Reins checkout>/packages/sdk`.

**The backend file** (`reins.backend`)

- One ES module for Bun that holds all the code it uses. Reins copies only this file, not its directory or `node_modules`: do not split it into chunks, and do not read other files of your package at run time. Keep your own files in `reins.dataDir`.
- Its default export is `{ migrations?, register(reins) }`, a `ServerExtension` from `@reins/sdk/server`. `register` returns a disposer, or nothing.

**The frontend file** (`reins.frontend`)

- One ES module for browsers, in a directory of its own (`dist/web/`). Reins copies that whole directory, and browsers can read each file in it: put no secrets there. Build the backend file into another directory (`dist/server/`), so its source map and anything else your backend build writes stay out of what browsers can read.
- Leave out `lit` and `lit/*` (`--external lit --external 'lit/*'`): the page gives them through an import map, so all extensions share one Lit. Bundle every other library, `@reins/sdk` and Svelte too.
- Import the module with your HTTP API's schemas with `import type`, so TypeBox stays out of the bundle.
- Its default export is a function `register(reins)` that returns a disposer.

**Custom elements** (only if you define them, as a Lit frontend does)

- Do not define them in the global `customElements` registry. A reload evaluates your module again with new classes, and the global registry cannot define a tag twice; its tags are also shared with Reins and other extensions.
- Use `@reins/sdk/lit`: `defineElement(name, class)` defines an element in a registry of your bundle's own and gives the tag to create it with; extend `ScopedElement`, which makes the elements in your templates through that registry and draws in the light DOM; `mountElement(target, tag, class, setup)` is a mount function's body.
- Draw in the light DOM, not in a shadow root: your scoped styles and the app's reach only the light DOM.
- Use `static properties` with `declare` fields, and set their values in the constructor: a class field initializer hides Lit's reactive property.

**The stylesheet** (`reins.styles`, optional)

- One file in the frontend directory. It must not `@import` other files.
- Reins scopes each rule to your views; `:root` and `:host` become the element your view is in. A state of the page's root (`html.dark`, `:root[data-theme=dark]`) stays on the page's root, so a class-based dark theme still works.
- The app's reset and font apply in your views, but the app's sheet holds only the classes the app uses. So, with Tailwind, build only its theme and the utilities your files use:

  ```css
  @layer theme, utilities;
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/utilities.css" layer(utilities) source(none);
  @source "./";
  ```

### Steps

1. Choose the name (lowercase letters, digits and hyphens, a letter first) and the label Settings shows.
2. Write `package.json` with the manifest, the dependencies above and the scripts `build`, `test` and `typecheck`. Any build tool that writes the files the manifest names works. For example, with Tailwind and Bun:

   ```sh
   tailwindcss -i src/styles.css -o dist/web/styles.css --minify
   bun build src/server.ts --target bun --outfile dist/server/index.js
   bun build src/frontend.ts --target browser --outfile dist/web/index.js --external lit --external 'lit/*'
   ```

3. Write the backend part, the frontend part, and a test of the backend part through a fake of the SDK (*Testing*). Write a README that says how to build and reload it.
4. Install, check and build: `bun install && bun test && bun run typecheck && bun run build`.
5. Add it, once, from its directory: `reins extension add "$PWD"`. If the CLI cannot reach the server, add `--local` (the server on this machine) or `--server <url>`.
6. After each change, build, then `reins extension reload <name>`. Reins runs its copy, so a build alone changes nothing; nothing watches your directory.
7. Check that it loaded: `reins extension list` shows its status, and why it failed (a failure a browser reported too). Open Settings → <label>.

## The manifest

The `reins` key of the extension's `package.json`; its version is the package's `version` (`0.0.0` without one). A key the table does not list makes the manifest invalid. Every file it names must be inside the extension's directory.

```json
{
  "name": "inbox",
  "version": "0.1.0",
  "type": "module",
  "reins": {
    "name": "inbox",
    "label": "Inbox",
    "description": "A local inbox for GitHub pull request and issue notifications.",
    "icon": "./icon.svg",
    "sdk": "^0.1.0",
    "backend": "./dist/server/index.js",
    "frontend": "./dist/web/index.js",
    "styles": "./dist/web/styles.css"
  }
}
```

| Field | |
|---|---|
| `name` | Required. Lowercase letters, digits and hyphens, a letter first; 64 characters at most. Its HTTP API, messages, data directory and Settings page are under it. It cannot be a built-in extension's name, nor `app` or `file-browser` (the browser keeps them). |
| `label` | Required, 80 characters at most. What Settings shows. |
| `description` | Optional, 300 characters at most: one or two sentences. |
| `icon` | Optional: an SVG file (at most 16 KiB), drawn in `currentColor` beside the label. |
| `sdk` | Required: the range of `@reins/sdk` versions it was written for (`^0.1.0`). Reins refuses to load it when its SDK is outside the range. |
| `backend` | The backend part: a built ES module for Bun, which runs in the server. |
| `frontend` | The frontend part: a built ES module for browsers, in a directory of its own (`dist/web/`), without the backend file. Browsers may load any file in that directory (its chunks). At least one of `backend` and `frontend`. |
| `styles` | Optional: a stylesheet in the frontend's directory; it needs a `frontend`. Reins scopes it to your views when it installs the extension (*Requirements*). |
| `node` | Reserved for parts that run on nodes. Not supported yet: a manifest with it does not load. |

## The backend part

The backend entry's default export is a `ServerExtension`: its database migrations and a register function, which gets the server SDK (`@reins/sdk/server`) and returns a disposer (`src/server.ts` above). It must register synchronously: an `async` register function fails the extension at `register`. Start async work in a service.

What `reins` gives (each in depth in [server-sdk.md](../dev/server-sdk.md), in a Reins checkout's `docs/dev`):

- **`http.handle(api, handlers)`**: its HTTP API, `POST /api/extensions/<name>/<method>`. Reins checks each input against the method's TypeBox schema (400 otherwise) before the handler. A thrown `Error` with a numeric `status` (400–599) is answered with it: `Object.assign(new Error("Connect GitHub first"), { status: 400 })`. **`http.page(path, handler)`**: a page the browser goes to itself, `GET /extensions/<name><path>` (an OAuth callback).
- **`db`** and **`migrations`**: its own SQLite database (`bun:sqlite`'s API: `query`, `exec`, `transaction`), in `<data dir>/extensions/<name>/db.sqlite`, migrated before `register` runs. Never change a migration that has shipped: add one. **`dataDir`**: its own directory.
- **`secrets`**: `get`, `set`, `delete`, `keys(prefix?)`, async, encrypted by Reins in its own database; for tokens. The browser never sees them unless the extension sends them.
- **`services.register({ name, start })`**: long-running work (polling). `start({ signal, logger, fail })`: end everything with `signal` (Reins aborts it on reload and shutdown), and report a loop that cannot go on with `fail(error)` (Reins restarts it with backoff). A polling loop:

  ```ts
  reins.services.register({
    name: "poller",
    start: ({ signal, fail }) => {
      void (async () => {
        while (!signal.aborted) {
          await poll(signal);
          await new Promise(resolve => { setTimeout(resolve, 60_000); signal.addEventListener("abort", resolve, { once: true }); });
        }
      })().catch(fail);
    },
  });
  ```
- **`broadcast(message)`**: a message to every browser, which only its frontend part hears (`reins.onMessage`).
- **`sessions`**: `start(prompt, { projectId, title, background? })` (a session, recorded as started by the extension), `send`, `get`, `list`, `wait`, `onSettled` (the end of each run of a session it started).
- **`projects`**, **`tasks`**, **`nodes`** (`list`, `get` with each node's sources, `readFile`, `writeFile`, `run(node, command, { cwd, timeoutMs, signal })`), **`models`**, **`images`**: the same methods agents have in `execute`.
- **`tools.register(provider)`**: tools agents find and call through `reins.tools` (their IDs are `<name>__<tool>`). **`scripting.register(namespace)`**: `reins.<namespace>` functions in agents' scripts. **`prompt.register(contribution)`**: a section of the system prompt.
- **`logger`**: the server's log, under the extension's name.

## The frontend part

The frontend entry's default export is a register function, which gets the Reins SDK (`@reins/sdk`) and returns a disposer. Type it with the backend part's API, so `http.call` is typed (`src/frontend.ts` above).

Everything an extension draws is a **mount function**: `mount(target)` draws into an element Reins made and returns `{ dispose }` (views also `update`). Any framework works: Lit, Svelte's `mount`, React's `createRoot`, plain DOM. Reins puts that element in your extension's scope (`SCOPE_ATTRIBUTE`), where your stylesheet applies.

**Styles** (*Requirements* above). Something you draw outside your views (a dialog appended to `document.body`) gets your styles when you put `SCOPE_ATTRIBUTE` (from `@reins/sdk`) on it, with your extension's name as its value. Do not add styles to the document's `<head>` yourself. Reins' design tokens and a UI kit for extensions are planned ([plan](../plans/extension-design-tokens-and-ui-kit.md)).

**Provided libraries.** The page provides only **Lit 3** (*Requirements*); bundle everything else, Svelte included (its compiled code must match its own runtime's version). A new major version of a provided library is a new SDK version.

What `reins` gives (in depth in [reins-sdk.md](../dev/reins-sdk.md)):

- **`http.call(method, input?)`**: its backend part's API; rejects with the server's message.
- **`onMessage(listener)`**: its backend part's broadcasts. **`onReconnect(listener)`**: the connection came back (messages may have been missed: read again).
- **`sidebar.registerSection({ id, title, mount })`**: a section of the sidebar (the user orders and hides sections in Settings → Sidebar; a new one comes last).
- **`views.register(name, { pane: { title, description, icon, mount } })`** and **`workspace.open(view, { in: "main" })`**: a page in the main area, with its own URL (`#/view/<name>?…`), or `{ in: "inspector" }` for a tab beside the conversation. Declare your view's type for TypeScript: `declare module "@reins/sdk" { interface ViewTypes { "hello-page": { view: "hello-page" } } }` (a `type`, not an `interface`). Open a session with `workspace.open({ view: "session", sessionId }, { in: "main" })` (declare `session: { view: "session"; sessionId: string }` the same way).
- **`settings.register({ mount })`**: its page in Settings (Settings → <label>).
- **`commands.register({ name, description, run })`**: a `/name` command in the composer. **`messages.registerDecorator`**: views in place of pieces of message text.
- **`sessions`**, **`projects`**, **`tasks`**: live lists with change events, and their actions; **`workspace.current()`** and **`onDidChange`**: what the main area shows.
- External links: plain `<a href target="_blank" rel="noopener noreferrer">`.

Keep schemas (TypeBox values) out of what the frontend imports as values: import the API module with `import type`, or the frontend bundle holds TypeBox too.

## Data, secrets and logs

| What | Where |
|---|---|
| Its database | `<data dir>/extensions/<name>/db.sqlite` (`reins.db`); `<data dir>` is `REINS_DATA_DIR`, else `.reins` where the server runs |
| Its files | `<data dir>/extensions/<name>/` (`reins.dataDir`) |
| Its secrets | Reins' main database, encrypted, scoped to it (`reins.secrets`) |
| Its log lines | The server's log, prefixed with its name (and its service's) |

Removing an extension keeps its data and secrets: adding it again finds them.

## Loading and reloading

- **`reins extension add <dir>`** records the directory, copies its built files into Reins (the manifest, the backend file, the icon and the frontend file's directory, which must be a directory of its own such as `dist/web/`) and loads the copy. Reins loads that copy at every start, so the extension runs even when your directory is gone or half rebuilt.
- **`reins extension reload <name>`** copies its built files again and loads them: its services stop and start on the new code, everything it registered is removed and registered again, and every open browser drops its frontend part and loads the new one. Build, then reload: a rebuild alone changes nothing, as Reins runs its copy. Nothing watches the directory.
- **`reins extension list`** and **`remove <name>`**.
- **`reins extension disable <name>`** and **`enable <name>`** turn it off and on (any extension, built in too): off, it stops, browsers drop its frontend part, it stays off after a restart, and it cannot be reloaded until it is on.
- **Settings → Extensions** shows each extension with where it came from, its version and status, what it registered, its services and recent errors, and Reload and Remove for yours ([extensions.md](extensions.md)).

A build or load that fails shows the extension as failed with the error (in Settings and from `add`/`reload`, exit 1); Reins and the other extensions go on. Common failures:

- *needs SDK ^x; this Reins provides y*: the `sdk` range.
- *Its backend file dist/server/index.js does not exist: build the extension first*: run your build.
- *Its backend module's default export must be { register, migrations? }*, *Its frontend module's default export is not a register function*.
- *Failed to resolve module specifier "…"* in a browser: the frontend bundle left out a library Reins does not provide; bundle it.
- *… has already been defined* or a frontend element that does not change after a reload: the element was defined in the global `customElements` registry. Define it with `@reins/sdk/lit`'s `defineElement` (*Requirements*).
- *crypto.randomUUID is not a function* (or another API missing) in one browser only: the page is not a secure context (plain http on another host than localhost), which lacks `crypto.randomUUID`, the clipboard and more. Do not depend on them.

A frontend part fails in a browser, not on the server, so each browser reports how it loaded: `reins extension list` shows the latest failure a browser reported, with its stack (*frontend failed in a browser at …*), and so do Settings → Extensions and `GET /api/installed-extensions` (`frontendFailure`). A browser that loads it, or a reload, clears it. An agent debugging an extension reads it there.

## Testing

Test the backend part with `bun test` in the extension's directory, through what its register function registers: give it a fake of the SDK parts it uses (an in-memory `bun:sqlite` database with its migrations applied, secrets in a `Map`, broadcasts recorded, `http.handle` keeping the handlers so a test calls them) and stub `globalThis.fetch` for outside services. Type the part of the SDK it uses (`Pick<ServerSdk, "db" | "secrets" | …>`) so the fake is checked. `bun run typecheck` checks both parts against the SDK.

## Not yet

Loading from a git URL or GitHub repository, or a distributed package; parts that run on nodes; libraries other than Lit provided (React); adding an extension from the browser; reloading on file changes; a published SDK package and a compatibility promise (the SDK changes with Reins: its `sdk` range is checked, nothing more).
