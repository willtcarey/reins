# ADR-037: One Pane for Every Container, and the Host Derives a Main-Area View's URL From the View

- **Status:** Accepted
- **Date:** 2026-11-06
- **Author:** Will (with Claude)
- **Amends:** [ADR-030](030-the-reins-sdk-and-how-views-mount.md) (`pane` shown in every container, its context naming the container, and `MountedView.subject`)

## Context

Extensions need full pages in the main area: a GitHub notifications inbox (Spoke, [pinned-plugin-apps.md](../plans/pinned-plugin-apps.md)) opened from a sidebar section, a project dashboard. The main area's state is the URL (frontend-architecture.md *Routing*): reload, Back and links must show the same page. So each page needs a URL, and something must turn a view into a URL and back.

A view is already a plain, serializable object whose `view` names its renderer (ADR-030). Its parameters can be strings, numbers, booleans, nulls and objects (a file's `source`). The app's own main-area views (`session`, `new-session`, `project-history`) already have URLs that users have bookmarked and that `localStorage` restores.

## Decision

**The host derives the URL from the view.** Views never handle URLs. A view of any name the app has no route of its own for is `#/view/<name>?<parameters>` (`routing/view-route.ts`, the `view` route in `routing/app-router.ts`):

- Each parameter is one query parameter. A string is written as itself (an empty one too), unless it would read as another JSON value (`"412"`, `"null"`): then it is written as JSON (`%22412%22`). Any other value is JSON. Reading gives JSON's value when the text parses, else the text. So numbers, booleans, nulls and nested objects come back as they went, and plain strings stay readable.
- Keys are in order, at every level of nesting, so a view has one URL whatever order its parameters were given in. `undefined` is left out, as JSON does.
- Only what a fragment cannot hold is escaped; `:`, `/`, `,` and `@` stay as they are (`#/view/github:inbox?repository=reins&source=%7B%22nodeId%22:%22laptop%22,…%7D`).
- The app's own views keep their routes (`OWN_ROUTES` in `app-router.ts`: `#/session/:id`, `#/new?project=&task=`, `#/projects/:id/history`). `#/view/<name>` refuses their names, so a view has one URL.

**One presentation for every container.** A view is one view wherever it is shown: the Inspector, the main area, and later a modal show the same `pane` presentation (`mount(target, view, context) → { update?, dispose?, subject? }`, with `title`, `description`, `icon`, and `width`, a hint only the Inspector reads). Each container draws its own frame from them: a tab, or in the main area the browser tab's title and the phone's header. The context, `PaneContext`, is the viewed session's source and the `container` the view is in, so a view fits its actions or layout to where it is without a second mount. No view is limited to some containers: app and extension code choose where they open a view (the Changes tree will mostly be in the Inspector, but nothing stops it opening in the main area). `inline` stays apart: it replaces a piece of message text, with that piece as its context, and is not a block in a container. The host gives the SDK its containers by ID, each with `open(view)` (`SdkHost.containers`: the Inspector, the main area), so `workspace.open(view, { in })` only looks the container up, and a modal will be one more entry. `workspace.open(view, { in: "main" })` (`RoutedMainArea`, `routing/main-area.ts`):

- refuses a view without a pane presentation, unless it is one of the app's own views;
- navigates: a history entry, so Back returns;
- replaces the entry, without a new one, when the view shown has the same identity (the name and its renderer's `key`), so the page is updated in place with the new view; opening exactly the route shown resolves it again, so the page gets a new view object (an open, as in the Inspector).

**A route whose renderer is not registered** (start-up of a later loader, a removed extension) shows *Page unavailable* in the main area, and the page mounts when the renderer registers: the workspace renders again on any registration.

**`workspace.current()` asks the view.** `MountedView.subject?()` gives what the main area's view is about now, asked when something needs it (a command, the host checking after the main area renders). Without it, the view is about nothing.

## Alternatives considered

- **A presentation for each container** (a `page` for the main area beside the Inspector's `pane`; the first form of this decision). The mounts had the same shape and differed only in metadata and context, so a file would have needed a second registration to open in the main area, and a modal a third. The file browser already shows the file viewer outside the registry for that reason.
- **A list of the containers a view allows** (`containers?: ContainerId[]`). Nothing needs it yet: where a view opens is the opener's choice, and a view can adapt from `context.container`.

- **Each view declares its URL form** (a path pattern on the renderer, `route: "/inbox/:repository"`). More to write and to get wrong for every extension, a second statement of the view's parameters that can disagree with the first, and a loader would have to check patterns for clashes. The derived URL handles any serializable view with nothing declared. Readable URLs for the app's own views stay a host table.
- **Extensions register routes on the router** (`router.register` with their own `renderPage`). Views would handle URLs and render outside the view lifecycle, and a route would be a second identity beside the view's key.
- **The whole view as JSON in one query parameter** (`#/view?v={…}`). Acceptable, but every string is quoted and escaped; one parameter each keeps strings and numbers readable and diffs of URLs small.
- **Base64 of the JSON.** Short and safe, but nobody can read or edit it.

## Consequences

- A view's parameter names are now its URL's: renaming one breaks links and the restored last route. A view whose parameters cannot be JSON (functions, `NaN`) does not round-trip; views were meant to be serializable already.
- A view's URL is the same in every browser, so links can be shared; it does not say which extension shows it, only its name (namespaced names, `"<plugin>:<name>"`, work as they are).
- A later external-extension loader needs nothing from this: a route shown before its extension loads mounts when it registers.
- The session stays rendered by `app-workspace` (its chat, Changes pane, toolbar and stores) rather than as a registered pane: making it a pane would need the workspace's stores in a mount and gains no extension anything. Its URL is the app's own. The new session page is a registered pane, by app code over `AppStore` (`registerNewSessionPage`, registered by `app-shell`).
- Details: [reins-sdk.md](../dev/reins-sdk.md) *Capabilities*, *Contribution points*; [frontend-architecture.md](../dev/frontend-architecture.md) *Routing*; [workspace-inspector.md](../plans/workspace-inspector.md) *Slice 4*.
