# Building extensions

An **extension** adds to Reins from outside it: a directory with a `package.json` and the files you built, which Reins loads. Reins builds nothing: you build your extension with any tools you like (Bun, Vite, Svelte, Tailwind), and its manifest names the results. It can give agents tools and script functions, run background services, keep its own database and secrets, answer HTTP calls, and add sidebar sections, pages, views, commands and a Settings page to the app. Reins' own features (MCP servers, automations, Recent sessions…) are extensions too ([extensions.md](extensions.md)); an extension you build uses the same two SDKs.

This guide is for a person, or an agent helping one, writing an extension: *Set up an extension* gives every file of a working one. Spoke, a GitHub notifications inbox, is a complete example outside this repository (its shape is at the end).

**Trust:** an extension runs inside the Reins server and inside the browser with their full authority (it can run commands on nodes, read Reins' data, and see what the page sees). Add only code you trust.

## Set up an extension

These steps make a working extension: a backend part with its own database and an HTTP method, a frontend part with a Settings page that calls it, a test, and a build. Follow them in a new directory outside Reins. They are `examples/hello-extension` in a Reins checkout, file for file (a test keeps them the same), so you may copy that directory instead.

1. **Choose its name and label.** The name is lowercase letters, digits and hyphens (`hello`), the label what Settings shows (`Hello`). In the files below, put your name in `package.json` (`name` and `reins.name`) and in the element's tag in `src/frontend.ts` (`hello-settings` becomes `<name>-settings`), and your label in `reins.label`.
2. **Write the files.** Lit, Tailwind and TypeBox are at the versions Reins uses: keep them, so your classes, elements and schemas match the app's. `@reins/sdk` is not published yet: point it at the `packages/sdk` directory of a Reins checkout on your machine.

<!-- example: package.json -->
```json
{
  "name": "hello",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tailwindcss -i src/styles.css -o dist/styles.css --minify && bun build src/server.ts --target bun --outfile dist/server.js && bun build src/frontend.ts --target browser --outfile dist/frontend.js --external lit --external 'lit/*'",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "reins": {
    "name": "hello",
    "label": "Hello",
    "description": "An example extension: a Settings page that greets, counting greetings in its own database.",
    "sdk": "^0.1.0",
    "backend": "./dist/server.js",
    "frontend": "./dist/frontend.js",
    "styles": "./dist/styles.css"
  },
  "devDependencies": {
    "@reins/sdk": "file:<Reins checkout>/packages/sdk",
    "@sinclair/typebox": "0.34.48",
    "lit": "3.3.2",
    "tailwindcss": "4.1.18",
    "@tailwindcss/cli": "4.1.18",
    "@types/bun": "^1.3.11",
    "typescript": "^5.9.3"
  }
}
```

<!-- example: tsconfig.json -->
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": [
      "ESNext",
      "DOM",
      "DOM.Iterable"
    ],
    "types": [
      "bun"
    ],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": [
    "src"
  ]
}
```

<!-- example: .gitignore -->
```
node_modules/
dist/
```

The HTTP API, schemas only, which both parts import (the frontend with `import type`, so its bundle holds no TypeBox):

<!-- example: src/api.ts -->
```ts
/** The backend part's HTTP API: what the frontend part calls with `reins.http.call`. Schemas only. */
import { Type } from "@sinclair/typebox";

export const api = {
  greet: {
    input: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }),
    output: Type.Object({ message: Type.String(), count: Type.Number() }),
  },
};

export type Api = typeof api;
```

The backend part (*The backend part*):

<!-- example: src/server.ts -->
```ts
/** The backend part: runs in the Reins server, with its own database. Its build bundles all it uses. */
import type { ServerExtension, ServerSdk } from "@reins/sdk/server";
import { api } from "./api.js";

/** Greets `name`, counting how often it was greeted; tells browsers. */
export function greet(reins: Pick<ServerSdk, "db" | "broadcast">, name: string) {
  reins.db.query("INSERT INTO greetings (name) VALUES (?)").run(name);
  const { count } = reins.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM greetings WHERE name = ?").get(name) ?? { count: 0 };
  reins.broadcast({ type: "greeted", name });
  return { message: `Hello, ${name}!`, count };
}

export default {
  migrations: [
    { id: "001_greetings", up: db => db.exec("CREATE TABLE greetings (name TEXT NOT NULL)") },
  ],
  register(reins) {
    return reins.http.handle(api, {
      greet: ({ input }) => greet(reins, input.name),
    });
  },
} satisfies ServerExtension;
```

Its test, through a fake of the SDK parts it uses (*Testing*):

<!-- example: src/server.test.ts -->
```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import extension, { greet } from "./server.js";

/** The part of the SDK `greet` uses: a database with the extension's migrations, and broadcasts recorded. */
function fakeReins() {
  const db = new Database(":memory:");
  for (const migration of extension.migrations) migration.up(db);
  const broadcasts: object[] = [];
  return { db, broadcast: (message: object) => { broadcasts.push(message); }, broadcasts };
}

test("greeting counts each name and tells browsers", () => {
  const reins = fakeReins();

  greet(reins, "Ada");
  const second = greet(reins, "Ada");

  expect(second).toEqual({ message: "Hello, Ada!", count: 2 });
  expect(reins.broadcasts).toEqual([{ type: "greeted", name: "Ada" }, { type: "greeted", name: "Ada" }]);
});
```

The frontend part (*The frontend part*):

<!-- example: src/frontend.ts -->
```ts
/** The frontend part: runs in the browser. Its build leaves Lit out: the app provides it. */
import type { ReinsSdk } from "@reins/sdk";
import { html } from "lit";
import type { Api } from "./api.js";
import { ScopedElement, defineElement, mountElement } from "./elements.js";

class Settings extends ScopedElement {
  static override properties = { message: { state: true } };
  declare message: string;
  reins: ReinsSdk<Api> | null = null;

  constructor() {
    super();
    this.message = "";
  }

  private async greet(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !this.reins) return;
    const name = String(new FormData(form).get("name") ?? "");
    const { message, count } = await this.reins.http.call("greet", { name });
    this.message = `${message} (${count})`;
  }

  override render() {
    return html`
      <form class="flex gap-2" @submit=${this.greet}>
        <input name="name" aria-label="Name" class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100" />
        <button class="rounded bg-zinc-700 px-2.5 py-1 text-xs text-zinc-100 hover:bg-zinc-600">Greet</button>
      </form>
      <p class="mt-2 text-xs text-zinc-400">${this.message}</p>
    `;
  }
}
const SETTINGS = defineElement("hello-settings", Settings);

export default function register(reins: ReinsSdk<Api>) {
  return reins.settings.register({
    mount: target => mountElement(target, SETTINGS, Settings, settings => { settings.reins = reins; }),
  });
}
```

Its own custom element registry, which a Lit extension needs (*Custom elements*):

<!-- example: src/elements.ts -->
```ts
/**
 * This extension's own custom element registry. A page's global registry binds a tag to one class for the page's
 * life, and a reload of the extension evaluates this module anew with new classes; it would also share tags
 * with Reins and other extensions. So each evaluation of this module makes a registry of its own
 * (`new CustomElementRegistry()`, scoped registries: Chrome 146, Safari 26, Firefox 159), defines the extension's
 * elements there under their plain names, and creates them through it. Reins knows nothing of it: it is the
 * extension's own code.
 *
 * Lit clones its templates with `document.importNode`, which uses the global registry, so the extension's elements
 * give Lit a `creationScope` that clones through this registry.
 *
 * In a browser without scoped registries, the elements go in the global registry under a tag unique to this
 * evaluation (`hello-settings-k3x9…`), which works the same apart from the names.
 *
 * Its styles need nothing here: Reins scopes its stylesheet (`reins.styles` in package.json) to the elements it
 * mounts its views in.
 */
import { LitElement } from "lit";

type ScopedDocument = Document & {
  createElement(tag: string, options: { customElementRegistry: CustomElementRegistry }): HTMLElement;
  importNode(node: Node, options: { customElementRegistry: CustomElementRegistry; selfOnly: boolean }): Node;
};

function scopedRegistry(): CustomElementRegistry | null {
  try {
    return Reflect.construct(CustomElementRegistry, []);
  } catch {
    return null;
  }
}

const registry = scopedRegistry();
const scopedDocument = (): ScopedDocument => Object.assign(document);
/** What Lit clones templates with: through the extension's registry when it has one. */
const creationScope = registry
  ? { importNode: (node: Node, deep?: boolean) => scopedDocument().importNode(node, { customElementRegistry: registry, selfOnly: !deep }) }
  : undefined;
const suffix = registry ? "" : `-${Math.random().toString(36).slice(2, 10)}`;

/** Defines `element` under `name` (in the global registry only as the fallback, with this evaluation's suffix);
 * returns the tag to create it with. */
export function defineElement(name: string, element: CustomElementConstructor): string {
  const tag = `${name}${suffix}`;
  (registry ?? customElements).define(tag, element);
  return tag;
}

/** A new element of `tag`, made through the extension's registry. */
export function createElement(tag: string): HTMLElement {
  return registry ? scopedDocument().createElement(tag, { customElementRegistry: registry }) : document.createElement(tag);
}

/** The extension's elements: their templates' elements made through its registry, drawn in the light DOM, where
 * its scoped styles and the app's reach them. */
export class ScopedElement extends LitElement {
  constructor() {
    super();
    if (creationScope) this.renderOptions.creationScope = creationScope;
  }

  override createRenderRoot() {
    return this;
  }
}

/** Mounts a new element of `tag`, set up by `setup`, into `target` (the element Reins mounts the view in). */
export function mountElement<T extends HTMLElement>(target: HTMLElement, tag: string, type: abstract new () => T, setup: (element: T) => void) {
  const element = createElement(tag);
  if (element instanceof type) setup(element);
  target.append(element);
  return { dispose: () => element.remove() };
}
```

Its stylesheet, which Reins scopes to its views (*Styles*):

<!-- example: src/styles.css -->
```css
/* Reins scopes this sheet to the extension's views when it installs it. The app's own styles (its reset, its
   font) reach those views, so only Tailwind's theme and utilities are here. */
@layer theme, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);
@source "./";
```

Add a `README.md` saying what it is and how to build it.

3. **Install, test, build, add.** `reins …` is `bun run reins …` from a Reins checkout; add `--local` on a machine paired as a node, or `--server <url>`:

```sh
bun install && bun test && bun run typecheck
bun run build                          # dist/: what Reins installs
reins extension add "$PWD"             # once: Reins copies dist/ and loads it
bun run build && reins extension reload hello   # after each change
```

`reins extension list` says whether it loaded, and why not (*Loading and reloading*). Open Settings → Hello to see its page.

The build is any tool that writes the files the manifest names; the example's is Tailwind and `bun build`. The backend bundle holds everything it uses. The frontend bundle leaves Lit out, as Reins provides it (*Provided libraries*).

## The manifest

The `reins` key of the extension's `package.json`; its `version` is the package's:

```json
{
  "name": "spoke",
  "version": "0.1.0",
  "type": "module",
  "reins": {
    "name": "spoke",
    "label": "Spoke",
    "description": "A local inbox for GitHub pull request and issue notifications.",
    "icon": "./icon.svg",
    "sdk": "^0.1.0",
    "backend": "./dist/server.js",
    "frontend": "./dist/frontend.js"
  }
}
```

| Field | |
|---|---|
| `name` | Required. Lowercase letters, digits and hyphens. Its HTTP API, messages, data directory and Settings page are under it. It cannot be a built-in extension's name. |
| `label` | Required. What Settings shows. |
| `description` | Optional, one or two sentences. |
| `icon` | Optional: an SVG file (at most 16 KiB), drawn in `currentColor` beside the label. |
| `sdk` | Required: the range of `@reins/sdk` versions it was written for (`^0.1.0`). Reins refuses to load it when its SDK is outside the range. |
| `backend` | The backend part: a built ES module for Bun, which runs in the server. |
| `frontend` | The frontend part: a built ES module for browsers, in a directory of its own (`dist/`). Browsers may load any file in that directory (its chunks), but not the backend file. At least one of `backend` and `frontend`. |
| `styles` | Optional: a stylesheet in the frontend's directory. Reins scopes it to your views when it installs the extension (*Styles*). |
| `node` | Reserved for parts that run on nodes. Not supported yet: a manifest with it does not load. |

## The backend part

The backend entry's default export is a `ServerExtension`: its database migrations and a register function, which gets the server SDK (`@reins/sdk/server`) and returns a disposer (`src/server.ts` above).

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

**Custom elements go in the extension's own registry.** The page's global registry (`customElements`) binds a tag to one class for the page's life, so a reloaded module could not define its new classes there, and it would share tags with Reins and other extensions. `src/elements.ts` (above) is the extension's own code: each evaluation of the module makes a `new CustomElementRegistry()` (scoped registries: Chrome 146, Safari 26, Firefox 159), `defineElement` defines there, `mountElement` mounts a view's element made through it, and `ScopedElement` (a light-DOM `LitElement`, so the app's styles and your scoped ones reach it) gives Lit a `creationScope`, so the elements its templates contain are made through it too. In an older browser it falls back to the global registry with tags unique to that evaluation. Reins knows nothing of any of it. An extension that defines no custom elements (Svelte, React, Vue, Solid, Lit's `render()`) needs none of this.

Everything an extension draws is a **mount function**: `mount(target)` draws into an element Reins made and returns `{ dispose }` (views also `update`). Any framework works: Lit, Svelte's `mount`, React's `createRoot`, plain DOM. Prefer `static properties` with `declare` fields to Lit's decorators, which depend on your `tsconfig`.

**Styles.** Name your stylesheet in the manifest (`"styles": "./dist/styles.css"`). When Reins installs the extension it scopes the sheet: every rule applies only inside the elements Reins mounts your views in, which carry `data-reins-extension="<name>"` (`:root` and `:host` mean that element, so a theme's variables are set there). So your CSS cannot restyle Reins or another extension, while Reins' own styles reach your views: its reset and font, and its Tailwind classes. The example's `src/styles.css` therefore builds only Tailwind's theme and the utilities your files use, at the app's Tailwind version (`@import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities) source(none);`). Use the app's classes (`bg-zinc-900`, `text-zinc-400`…) to look like it. A sheet must be one file: one that `@import`s another fails the install. Something you draw outside your views (a dialog appended to `document.body`) gets your styles when you put the attribute on it (`SCOPE_ATTRIBUTE` from `@reins/sdk`, with your extension's name). Do not add styles to the document's `<head>` yourself. Reins' design tokens and a UI kit for extensions are planned ([plan](../plans/extension-design-tokens-and-ui-kit.md)).

**Provided libraries.** Reins' page provides **Lit 3** through an import map: `lit` and every `lit/…` module. Leave them out of your frontend bundle (`--external lit --external 'lit/*'`), and the browser loads Reins' copy. Bundle everything else, Svelte included (its compiled code must match its own runtime's version). A new major version of a provided library is a new SDK version.

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

- **`reins extension add <dir>`** records the directory, copies its built files into Reins (the manifest, the backend file, the icon and the frontend file's directory, which must be a directory of its own such as `dist/`) and loads the copy. Reins loads that copy at every start, so the extension runs even when your directory is gone or half rebuilt.
- **`reins extension reload <name>`** copies its built files again and loads them: its services stop and start on the new code, everything it registered is removed and registered again, and every open browser drops its frontend part and loads the new one. Build, then reload: a rebuild alone changes nothing, as Reins runs its copy. Nothing watches the directory.
- **`reins extension list`** and **`remove <name>`**.
- **`reins extension disable <name>`** and **`enable <name>`** turn it off and on (any extension, built in too): off, it stops, browsers drop its frontend part, it stays off after a restart, and it cannot be reloaded until it is on.
- **Settings → Extensions** shows each extension with where it came from, its version and status, what it registered, its services and recent errors, and Reload and Remove for yours ([extensions.md](extensions.md)).

A build or load that fails shows the extension as failed with the error (in Settings and from `add`/`reload`, exit 1); Reins and the other extensions go on. Common failures:

- *needs SDK ^x; this Reins provides y*: the `sdk` range.
- *Its backend file dist/server.js does not exist: build the extension first*: run your build.
- *Its backend module's default export must be { register, migrations? }*, *Its frontend module's default export is not a register function*.
- *Failed to resolve module specifier "…"* in a browser: the frontend bundle left out a library Reins does not provide; bundle it.
- *… has already been defined* or a frontend element that does not change after a reload: the element was defined in the global `customElements` registry. Define it in the extension's own registry (`src/elements.ts`, above).
- *crypto.randomUUID is not a function* (or another API missing) in one browser only: the page is not a secure context (plain http on another host than localhost), which lacks `crypto.randomUUID`, the clipboard and more. Do not depend on them.

A frontend part fails in a browser, not on the server, so each browser reports how it loaded: `reins extension list` shows the latest failure a browser reported, with its stack (*frontend failed in a browser at …*), and so do Settings → Extensions and `GET /api/installed-extensions` (`frontendFailure`). A browser that loads it, or a reload, clears it. An agent debugging an extension reads it there.

## Testing

Test the backend part with `bun test` in the extension's directory, through what its register function registers: give it a fake of the SDK parts it uses (an in-memory `bun:sqlite` database with its migrations applied, secrets in a `Map`, broadcasts recorded, `http.handle` keeping the handlers so a test calls them) and stub `globalThis.fetch` for outside services. Type the part of the SDK it uses (`Pick<ServerSdk, "db" | "secrets" | …>`) so the fake is checked. The example's `src/server.test.ts` and Spoke's `test/fake-reins.ts` show both. `bun run typecheck` checks both parts against the SDK.

## Example: Spoke

Spoke (`~/Workspaces/spoke-reins` for its author) is a GitHub notifications inbox:

- **Backend** (`src/backend.ts`, `src/sync.ts`): migrations for the inbox, a `poller` service that syncs with GitHub (ETags, GitHub's `X-Poll-Interval`), an HTTP API (`src/api.ts`: `state`, `sync`, `archive`, `markRead`, `investigate`, the OAuth device flow, settings, repository mappings), the token in `secrets`, a `broadcast` after each change, and "Review", which calls `reins.sessions.start(prompt, { projectId, title })` in the project mapped to the repository and stores the session ID. It suggests mappings by running `git remote get-url origin` in each project's default source with `reins.nodes.run`.
- **Build** (`bun run build`): `dist/server.js`, `dist/frontend.js` (Lit left out) and `dist/styles.css` (its Tailwind theme and utilities, which Reins scopes).
- **Frontend** (`src/frontend/`): a store shared by its views (reads `state` on `onMessage` and `onReconnect`), a sidebar section with the unread counts that opens the inbox (`workspace.open({ view: "spoke-inbox" }, { in: "main" })`), the inbox page (a `pane` view), and a Settings page (connect GitHub, a token, the poll interval, repositories → projects). Lit, with Tailwind classes like the app's, its elements in a registry of its own (`src/frontend/elements.ts`).
- **Tests** (`test/`): the BB version's server tests, ported to a fake host.

## Not yet

Loading from a git URL or GitHub repository, or a distributed package; parts that run on nodes; libraries other than Lit provided (React); adding an extension from the browser; reloading on file changes; a published SDK package and a compatibility promise (the SDK changes with Reins: its `sdk` range is checked, nothing more).
