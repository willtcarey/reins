# ADR-037: Views in the Main Area and the Inspector

- **Status:** Accepted
- **Date:** 2026-11-06
- **Author:** Will (with Claude)
- **Amends:** [ADR-030](030-the-reins-sdk-and-how-views-mount.md) (`pane` shown in every container, its context naming the container, and `MountedView.subject`)

This record merges three made while building slices 4 to 6 of [workspace-inspector.md](../plans/workspace-inspector.md): routed pages, the session's tabs, and views that find their own session. It gives the decisions as they stand.

## Context

Extensions need full pages in the main area: a GitHub notifications inbox (Spoke, [pinned-plugin-apps.md](../plans/completed/pinned-plugin-apps.md)) opened from a sidebar section, a project dashboard, another view of a session (a timeline, a pull request). The main area's state is the URL (frontend-architecture.md *Routing*): reload, Back and links must show the same page. The app's own main-area views (`session`, `new-session`, `project-history`) already had URLs that users bookmarked and that `localStorage` restores.

A view is a plain, serializable object whose `view` names its renderer (ADR-030). Before this, the session was hardcoded in `app-workspace`: its Chat and Changes as two columns on a wide screen and two swipe pages on a phone, under a toolbar with a Chat/Changes switch. `app-workspace` owned the session's state in one `WorkspaceStore` (the active session, its project, the diff and the review), registered the session's views and the Inspector's Changes tree over it, and always showed the Changes tab. The review in the main area and the tree in the Inspector shared one `DiffStore` to agree on the diff, its mode and the file the review was on, and a click in the tree scrolled the review by finding it in the DOM.

## Decision

### One presentation for every container

A view is one view wherever it is shown: the Inspector, the main area, and later a modal show the same `pane` presentation (`mount(target, view, context) → { update?, dispose?, subject?, setVisible? }`, with `title`, `description`, `icon`, and `width`, a hint only the Inspector reads). Each container draws its own frame from them: a tab, or in the main area the browser tab's title and the phone's header. `PaneContext` is the `container` the view is in and `subjectChanged()`, so a view fits its actions or layout to where it is without a second mount. It holds no source: a view shows what its own parameters name (a file names its source), and a file tab is titled by its file's name and path. No view is limited to some containers: app and extension code choose where they open a view. `inline` stays apart: it replaces a piece of message text, with that piece as its context.

The host gives the SDK its containers by ID, each with `open(view)` (`SdkHost.containers`: the Inspector, the main area), so `workspace.open(view, { in })` only looks the container up, and a modal will be one more entry.

### The host derives a main-area view's URL from the view

Views never handle URLs. A view of any name the app has no route of its own for is `#/view/<name>?<parameters>` (`routing/view-route.ts`, the `view` route in `routing/app-router.ts`):

- Each parameter is one query parameter. A string is written as itself (an empty one too), unless it would read as another JSON value (`"412"`, `"null"`): then it is written as JSON (`%22412%22`). Any other value is JSON. Reading gives JSON's value when the text parses, else the text.
- Keys are in order, at every level of nesting, so a view has one URL whatever order its parameters were given in. `undefined` is left out, as JSON does.
- Only what a fragment cannot hold is escaped; `:`, `/`, `,` and `@` stay as they are.
- The app's own views keep their routes (`OWN_ROUTES` in `app-router.ts`: `#/session/:id`, `#/session/:id/changes?file=`, `#/new?project=&task=`, `#/projects/:id/history`). `#/view/<name>` refuses their names, so a view has one URL.

`workspace.open(view, { in: "main" })` (`RoutedMainArea`, `routing/main-area.ts`) refuses a view without a pane, unless it is one of the app's own; navigates with a history entry, so Back returns; and replaces the entry when the view shown has the same identity (the name and its renderer's `key`), so the page is updated in place. A route whose renderer is not registered shows *Page unavailable*, and the page mounts when the renderer registers.

### A view can be a tab of a kind of subject

A session's Chat and Changes are two views, `session` and `session-changes`, registered by app code (`components/session-views.ts`), not an extension. A view can be one of the tabs of a kind of subject (`ViewRenderer.tabOf: { type, parameter }`). While the main area shows such a view, the host shows a tab for every view registered as a tab of the same kind, for the same ID (`ViewRegistry.tabsFor`): the app's first, then extensions' in registration order. The host owns the tabs, so it draws them in its toolbar before the shown view's own `toolbar`, makes each one a swipe page on a phone, and keeps them all mounted, telling hidden ones (`MountedView.setVisible`). Every container keys its mounts by the view's identity (the name and the renderer's `key`), so `update` is only ever a new open of the same view: another session's tabs, and their toolbar, are mounted anew. Switching tabs is an ordinary open: a history entry, and each tab has a link.

### The main area's subject, and views that find their own session

`workspace.current()` asks the shown view: `MountedView.subject?()` gives what it is about now (none without it). A view says its subject changed with `PaneContext.subjectChanged()`; the host then dispatches the main area's change to `onDidChange` listeners.

Each view finds its session from its own view or from that subject, and loads what it shows through the app's caches:

- The session's Chat makes its own `ActiveSessionStore` for its view's `sessionId`.
- The session's Changes and its toolbar use the session's `SessionDiff` from `AppStore.diffs` (`SessionDiffs`, `models/stores/session-diffs.ts`): one per session while a view uses it, reference counted, holding the server's answers (the changed files and patch, the review, ahead/behind) and the operations (push, rebase), scoped by itself from the session's details.
- The Inspector's Changes tree follows the main area through the SDK's `workspace` like an extension: the `session` subject chooses its `SessionDiff`, and the `file` subject (`{ source, path }`) is the file it highlights.

What two views must agree on is shared data or navigation. What the diff shows (branch or uncommitted changes) is the session's `SessionDiff`'s, and is not in the URL. The file the review is on is the Changes view's `file` subject. A file chosen in the tree opens `{ view: "session-changes", sessionId, file }` in the main area: the same view by key, in place, which reveals the file.

### The workspace is a frame

`app-workspace` draws the sidebar, the main area's tabs and pages, the Inspector and the resize handles, and owns no session state; `WorkspaceStore` is gone. The Inspector shows when it has tabs. Tabs can be pinned (`Inspector.pin(view)`, counted, released by the code that pinned them); the session's views pin the Changes tab while mounted. Tabs stay until closed, also across sessions in other checkouts. Only ⌘P reads the shown view's `session` subject, when pressed, until the SDK has keyboard shortcuts. The server's `open_file` for the shown session is a listener of app-shell's over the SDK's `workspace`.

## Alternatives considered

- **A presentation for each container** (a `page` beside the Inspector's `pane`). The mounts had the same shape, so a file would have needed a second registration to open in the main area, and a modal a third.
- **A list of the containers a view allows.** Where a view opens is the opener's choice, and a view can adapt from `context.container`.
- **Each view declares its URL form** (`route: "/inbox/:repository"`). More to write and get wrong, a second statement of the view's parameters, and a loader would check patterns for clashes.
- **Extensions register routes on the router.** Views would handle URLs and render outside the view lifecycle, and a route would be a second identity beside the view's key.
- **The whole view as JSON, or base64, in one query parameter.** Strings quoted and escaped, or unreadable; one parameter each keeps URLs readable.
- **Sections inside one session view**, drawn as tabs by the host. An extension wanting another view of a session would have to add a section to a view it does not own, and every container would have to support sections.
- **One session view that switches inside itself, with Changes on a phone in the Inspector.** The phone's swipe to Changes becomes the Inspector's, and the view and its toolbar must share which section is shown.
- **Replacing the history entry on a tab switch**, and **mounting a tab only when first shown** (a phone's swipe shows the next page while it moves, which would be empty).
- **The workspace following the shown view's session for all views** (the first form of slice 5): the Inspector's source, the diff and the review in one store, with a "viewed source" given to panes. Views were not independent, and features compared files with a session they did not show.
- **A viewed-session module owning the stores**, made by app-shell. It only moves the special case out of `app-workspace`.
- **The Changes view drawing its own file list** in place of the Inspector's tree. Odd beside other Inspector tabs.
- **What the diff shows as a parameter of the Changes view, in its URL.** The tabs would have to remember their views, and the tree would learn the choice from a subject.
- **A diff capability in the SDK.** The review's shape would become the contract.

## Consequences

- A view's parameter names are its URL's: renaming one breaks links and the restored last route. A view whose parameters cannot be JSON does not round-trip.
- A view's URL is the same in every browser, so links can be shared; a later external-extension loader needs nothing more, as a route shown before its extension loads mounts when it registers.
- An extension adds a tab to every session by registering a view with `tabOf: { type: "session", parameter: … }`. A tab is mounted while its set is shown, so a costly one waits for `setVisible(true)`.
- `onDidChange` listeners hear every subject change, also each file while the review scrolls; a listener that draws only some subjects draws again only when they change.
- A session's two views fetch its diff once, and it is dropped when no view of the session is shown. The tree's open folders and the diff mode are per session. The tree highlights nothing while Chat is shown.
- ⌘P needs the shown session's details in `SessionCache`, which the session's views load.
- Details: [reins-sdk.md](../dev/reins-sdk.md) *Capabilities*, *Contribution points*, *Views over the app's state*; [frontend-architecture.md](../dev/frontend-architecture.md) *Routing*, *Store map*, *Component structure*, *Mobile workspace swipe*; [workspace-inspector.md](../plans/workspace-inspector.md) slices 4 to 6.
