# ADR-039: Views Find Their Own Session; the Workspace Owns No Session State

- **Status:** Accepted
- **Date:** 2026-11-06
- **Author:** Will (with Claude)
- **Amends:** [ADR-038](038-main-area-tabs-are-views-of-a-subject.md) (the session the workspace follows)

## Context

After ADR-038, `app-workspace` still owned the session's state, one `WorkspaceStore` (the active session, its project, the diff and the review) and the changed-files tree's folders. It registered the session's views and the Inspector's Changes tree over that store, followed the shown view's session for them, and always showed the Changes tab in the Inspector. Two views in different containers (the Changes review in the main area, the tree in the Inspector) shared one `DiffStore` to agree on the diff, the diff mode and the file the review was on, and a click in the tree scrolled the review by finding it in the DOM. Views were not independent of each other, and the Inspector had a special case.

## Decision

**Each view finds its session from its own view or from the main area's subject**, and loads what it shows through the app's caches:

- The session's Chat makes its own `ActiveSessionStore` for its view's `sessionId`.
- The session's Changes and its toolbar use the session's `SessionDiff` from `AppStore.diffs` (`SessionDiffs`, `models/stores/session-diffs.ts`): one per session while a view uses it, reference counted, holding the server's answers (the changed files and patch, the review, ahead/behind) and the operations (push, rebase), scoped by itself from the session's details.
- The Inspector's Changes tree follows the main area through the SDK's `workspace` like an extension: the `session` subject chooses its `SessionDiff`, and the `file` subject (`{ source, path }`) is the file it highlights.

**What two views must agree on is either shared data or navigation:**

- What the diff shows (branch or uncommitted changes, later a commit) is the session's `SessionDiff`'s, so both views read it. It is not in the URL: a commit shown is not something to keep or link, and it goes back to branch changes when the entry is dropped.
- The file the review is on is the Changes view's subject, first (`file`), and the view says it changed with `PaneContext.subjectChanged()`.
- A file chosen in the tree opens `{ view: "session-changes", sessionId, file }` in the main area: the same view by key, in place, which reveals the file (`#/session/:id/changes?file=`).

**The Inspector shows when it has tabs.** Tabs can be pinned (`Inspector.pin(view)`, counted, released by the code that pinned them); the session's views pin the Changes tab while mounted. A page with nothing for the Inspector gives it no room.

**`app-workspace` is the frame**: the sidebar, the main area's tabs and pages, the Inspector, the resize handles. It keeps no viewed session: panes get no source (`PaneContext` is the container and `subjectChanged`), as a view shows what its own parameters name; a file tab is titled by its file's name and path, with no node, and the file browser names its node in its header's tooltip; the Inspector's provisional policy of closing tabs on a session in another checkout is dropped. Only ⌘P reads the shown view's `session` subject when pressed, until the SDK has keyboard shortcuts. `WorkspaceStore` is gone; the server's `open_file` for the shown session is a listener of app-shell's over the SDK's `workspace`.

## Alternatives considered

- **A viewed-session module owning the stores**, made by app-shell. It only moves the special case out of `app-workspace`: the views would still share one store.
- **The Changes view drawing its own file list** in place of the Inspector's tree. Removes the cross-container coupling, but it is odd beside other Inspector tabs.
- **What the diff shows as a parameter of the Changes view, in its URL.** Links and Back for a commit, but the tabs would have to remember their views and the tree would have to learn the choice from a subject.
- **A diff capability in the SDK.** The review's shape would become the contract; app views use app state, and an extension needing a session's changes would need a capability designed for it.

## Consequences

- A view that is about a file (a file page, the review) makes the tree highlight it; the tree highlights nothing while Chat is shown.
- The tree's open folders are per session, and the diff mode is per session (it was one choice for every session).
- A session's two views fetch its diff once, and the diff is dropped when no view of the session is shown.
- ⌘P needs the shown session's details in `SessionCache`, which the session's views load.
- Inspector tabs stay until closed, also across sessions in other checkouts.
- Details: [reins-sdk.md](../dev/reins-sdk.md) *Views over the app's state*; [frontend-architecture.md](../dev/frontend-architecture.md) *Store map*, *Component structure*; [workspace-inspector.md](../plans/workspace-inspector.md) slice 6.
