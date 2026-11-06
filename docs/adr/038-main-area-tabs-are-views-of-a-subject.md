# ADR-038: The Main Area's Tabs Are Views of One Subject

- **Status:** Accepted
- **Date:** 2026-11-06
- **Author:** Will (with Claude)
- **Amends:** [ADR-037](037-the-host-derives-a-main-area-views-url.md) (the main area shows a view with its tabs)

## Context

A session in the main area is two things the user switches between, its Chat and its Changes: two columns on a wide screen and two swipe pages on a phone, under a toolbar with a Chat/Changes switch. They were hardcoded in `app-workspace`. Making the session a view (ADR-037) raised how the switch, the toolbar and the phone's pages work for it, and how an extension could add another view of a session (a timeline, a pull request).

## Decision

**Chat and Changes are two views**, `session` (`#/session/:id`) and `session-changes` (`#/session/:id/changes`), registered by app code over the workspace's store (`components/session-views.ts`), not an extension.

**A view can be one of the tabs of a kind of subject** (`ViewRenderer.tabOf: { type, parameter }`). While the main area shows such a view, the host shows a tab for every view registered as a tab of the same kind, for the same ID (`ViewRegistry.tabsFor`): the app's first, then extensions' in registration order. The host owns the tabs, so it can:

- draw them in its toolbar, before the shown view's own `toolbar` (the session's: its files and branch);
- make each one a swipe page on a phone, between the sessions and the Inspector;
- keep them all mounted, telling hidden ones (`MountedView.setVisible`), so switching does not mount the diff review again.

**Switching tabs is an ordinary open**: a history entry, so Back goes through the tabs visited, and each tab has a link.

## Alternatives considered

- **Sections inside one view** (a session pane with named sections the host draws as tabs). Same behavior for users, but an extension wanting another view of a session would have to add a section to a view it does not own, a new kind of contribution, and every container would have to support sections.
- **One session view that switches inside itself, with Changes on a phone in the Inspector.** Keeps the container simple, but the phone's swipe to Changes becomes the Inspector's, and the view and its toolbar must share which section is shown.
- **Replacing the history entry on a switch.** Rejected by choice: a tab switch is navigation like any other.
- **A tab mounted only the first time it is shown.** A phone's swipe shows the next page while it moves, which would be empty.

## Consequences

- An extension adds a tab to every session by registering a view with `tabOf: { type: "session", parameter: … }`; it needs nothing else.
- A tab is mounted while its set is shown, so an extension's tab costs its mount even unseen; a costly one waits for `setVisible(true)`.
- The session the workspace follows (the Inspector's source, the diff and the review) still comes from the session routes; it is to come from the shown view's `session` subject (workspace-inspector.md slice 5).
- Details: [reins-sdk.md](../dev/reins-sdk.md) *Contribution points*, *Views over the app's state*; [frontend-architecture.md](../dev/frontend-architecture.md) *Component structure*, *Mobile workspace swipe*.
