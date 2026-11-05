# ADR-035: The Sidebar Is a Host-Owned Frame Around a Stack of Sections the User Arranges

- **Status:** Accepted
- **Date:** 2026-11-04
- **Author:** Will (with Claude)
- **Amends:** [ADR-030](030-the-reins-sdk-and-how-views-mount.md) (a new contribution point, with the views' mount lifecycle)

## Context

The sidebar's body was one fixed tree: every project by name, each expandable, then sessions of no project and Add project. With about 30 projects, finding the sessions that need attention meant scrolling and expanding. We want the sidebar's parts to be swappable as the extension framework opens up, and the common paths (what needs me, what I worked on last) to be short.

## Decision

**Sections only.** `reins.sidebar.registerSection({ id, title?, mount })` adds a section: a mount function with a Settings page's lifecycle (`mount(target) → { dispose? }`), run by `<reins-view-mount>`. There is no separate "navigator" concept: the project tree is a section like any other.

**The host owns the frame**: the header, collapse, the collapsed rail and its activity badge (computed from every session, not from sections), and the phone's page. A section cannot add to them.

**The user owns the order, not the extensions.** Extensions do not give a position or a priority. The user orders sections and turns them on or off in Settings → Sidebar, stored as the server's `sidebar_sections` setting (`{ order, hidden }` by ID). Sections the user has not ordered follow, in registration order, switched on; the built-ins' registration order (Recent, Projects) is the default.

**Height**: each section is as tall as its content, and the sidebar's body is its one scroller. A first version had `fill` (a section taking the remaining height and scrolling on its own, the others capped at 40%); it was dropped because nested scroll areas in a narrow sidebar were harder to use than one long scroll.

**Live data comes from the SDK**, not app stores: `projects`, `tasks` and `sessions` are synchronous reads of what the host has, with `onDidChange` events that say which projects, tasks or sessions changed, and session and project actions. They reuse `ProjectsStore` and `SessionCache` underneath. The built-in sections import only the SDK, the app's UI kit and its generic Lit controllers.

## Alternatives considered

- **Extension-declared order or priority.** Rejected: two extensions both wanting to be first cannot both win, and the user, not the extension, knows which parts matter to them.
- **A "navigator" contribution beside sections** (one section that owns the tree). Rejected as a second concept with no second adapter: the tree is one section.
- **Sections given the app's stores** (as the diff file tree, app code over app state). Rejected for the built-ins, so that a section can be replaced by one that knows only the SDK.

## Consequences

- A section's policy belongs to its extension, not the core. Recent's (which sessions are recent; a closed task puts its sessions away) is in its backend part, over the server SDK's `sessions.list`, `projects.get` and `tasks.get`; a first version had it in the core (`/api/sessions/recent`, `reins.sessions.recent()`, a `taskClosedAt` on every session), which only Recent used.

- A first version also had a Needs attention section (running and unread sessions). It was dropped before release: with Recent beside it, most rows were in both. The collapsed rail's dot still shows activity.

- The tree's dialogs (task form, task details, project form, rename, move) live in the Projects section for now; making them host actions any section can ask for is later work.
- The frontend SDK grew `projects`, `tasks`, `nodes`, `sessions.list` and session actions, their `onDidChange` events, and `workspace.onDidChange`; the server SDK `sessions.list`, `projects.get` and `tasks.get`. Other features reuse them.
- The arrangement is one per user (server setting), not per device.
