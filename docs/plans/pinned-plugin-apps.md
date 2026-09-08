# Pinned Plugin Apps

Status: **deferred early design** — this is not the next implementation priority.

## Goal

Let users install small, self-contained applications that appear as pinned destinations at the top of the Reins sidebar. Selecting an app opens a plugin-owned workspace without turning that app's workflow into permanent Reins core behavior.

The first intended application is a Reins version of **Spoke**, the GitHub notification inbox currently implemented for BB in `/home/will/Workspaces/bb-plugin-github-notifications`.

This plan narrows the initial extension problem to one product capability:

> A plugin app contributes a sidebar launcher, an optional live accessory such as counts or status, and a full workspace destination.

It does not attempt to make every Reins surface pluggable.

## Motivation

Reins currently encodes a specific session/task/review workflow directly into its application shell. Adding every adjacent workflow to core would make the product harder to change and force unrelated applications to share the same navigation and lifecycle assumptions.

Pinned plugin apps provide a home for adjacent workflows while keeping the host small:

- users can add focused tools without expanding Reins core navigation indefinitely
- app code can choose its own frontend libraries rather than requiring Reins to recreate every UI primitive
- plugin-owned storage, settings, background work, and realtime state stay local to that application
- Reins exposes narrow capabilities such as listing projects or starting a session instead of application-specific GitHub behavior

## Reference: BB Spoke

Spoke is a useful acceptance case because it exercises more than static UI. Its BB implementation:

- registers a full navigation panel with a sidebar accessory showing pull-request and issue counts
- renders a plugin-owned React page
- defines secret and non-secret settings
- owns a SQLite database and migrations
- polls GitHub in a background service
- publishes realtime invalidations to its frontend
- exposes typed RPC between its frontend and server code
- reads host projects, matches a GitHub remote, and starts a review thread

Its app contribution is conceptually small:

```ts
app.slots.navPanel({
  id: "notifications",
  title: "Spoke",
  icon: "Github",
  path: "notifications",
  component: NotificationsPage,
  experimental_sidebarAccessory: SidebarCounts,
});
```

The leverage comes from the host capabilities behind that registration. Spoke still owns substantial application and presentation code; the plugin system makes independent development possible rather than making the application trivial.

## Product shape

### Sidebar

Pinned apps appear in a host-owned section above projects. The host owns row layout, ordering, focus, active styling, and mobile navigation behavior. A plugin supplies identity, labeling, icon data, and an optional bounded accessory such as unread counts.

The first version may show every enabled app in deterministic order. User pinning, hiding, and reordering can follow after more than one app exists.

### Routing and workspace

Add an app destination alongside session destinations:

```txt
#/session/:sessionId
#/apps/:appId
```

Selecting an app must not force it into the four-pane session topology.

- On desktop, the sidebar remains mounted and the app owns the workspace to its right.
- On mobile, selecting the app closes the sidebar and shows one full-viewport app page.
- Returning to a session restores the existing session workspace and its route-derived state.

This is navigation, not tiling. Arbitrary docking, movable panels, and user-designed workspace layouts are outside the initial capability.

### Failure behavior

A broken app must not strand the user. The host keeps the sidebar and renders a host-owned error surface with disable/reload actions. A failed accessory disappears or falls back to the app's plain launcher rather than breaking sidebar rendering.

## Initial runtime model

Match BB's practical model for the first implementation: installed plugins are **trusted same-process code**.

- A frontend plugin bundle is loaded into the Reins page and mounts inside a host-owned app surface.
- A backend plugin entry is dynamically loaded into the Reins server and receives a scoped plugin interface.
- Plugins are not security-sandboxed. Installing one grants it effectively the same authority as Reins, even if the supported interface is narrower.

The scoped interface still matters for locality, testability, compatibility, and a possible future process boundary. Capability inputs and outputs should remain asynchronous and serializable where practical. Lifecycle and cancellation must be explicit so a future worker/process adapter does not require redesigning application behavior.

This is intentionally a first implementation decision, not a promise that all future plugins will always share the process. It creates tension with the general guidance in `docs/dev/extension-architecture.md`, which says contracts should not assume process, framework, DOM, or trust level. Before implementation, resolve that tension explicitly: keep domain capabilities process-independent while treating frontend mounting and the initial trusted loader as adapters rather than universal SDK guarantees.

## Proposed host modules

The interfaces below are illustrative, not yet supported contracts.

### Plugin lifecycle

One module should own discovery, validation, loading, activation, failure state, and disposal. Callers should not coordinate frontend bundles, backend factories, databases, background services, and realtime subscriptions independently.

Important lifecycle facts:

- one active generation per plugin
- deterministic registration order
- failed activation does not replace a working generation during development reload
- disposal aborts background work, subscriptions, and pending RPC
- plugin-owned database handles close on disposal
- frontend app mounts receive an explicit disposer

### App contributions

A small app registry should expose stable host-owned metadata and opaque mount behavior without exposing Reins component internals:

```ts
type PluginAppContribution = {
  id: string;
  title: string;
  icon: PluginIcon;
  mountApp: PluginMount;
  mountAccessory?: PluginMount;
};
```

The exact `PluginMount` shape needs design work. It must be framework-neutral and compatible with Lit, React, vanilla JavaScript, and a future isolated adapter. Options include a host-owned mount container, a required Custom Element entry, or a more declarative app protocol. Avoid exposing Lit templates or internal store objects.

Same-process execution does not require shared CSS. A host-created Shadow Root or an equivalent scoped style target may prevent plugin styles from leaking while allowing inherited Reins design tokens. The plugin may bundle its own framework and component library; bundles should load lazily when their app or accessory is first needed.

### Plugin frontend/backend communication

Provide plugin-scoped typed RPC rather than allowing each application to add arbitrary Reins routes. The host owns transport, cancellation, validation, output limits, and error normalization. Realtime topics are namespaced to the plugin.

### Plugin-owned infrastructure

The Spoke acceptance case requires:

- namespaced SQLite storage and ordered migrations
- declarative settings, including secrets that never enter frontend state
- cancellable background services
- namespaced realtime publication/subscription
- plugin-scoped logging

These should be deep host modules rather than wrappers over raw Reins database, WebSocket, or router objects.

### Narrow Reins capabilities

Spoke initially needs only a small set of host operations:

- list projects with stable identity and Git remote metadata
- start a project session/task with a title and initial prompt
- navigate the frontend to a returned session
- open an external URL

Use Reins-owned values and return results. Do not expose `AppStore`, SQLite rows, router contexts, WebSocket clients, or runtime session objects.

## Spoke acceptance story

A first useful plugin should be able to:

1. Register a **Spoke** launcher above the project list.
2. Show separate pull-request and issue counts in its sidebar accessory.
3. Configure GitHub through a secret token or OAuth device flow.
4. Poll notifications in the background without requiring the page to be open.
5. Read its inbox from plugin-owned local storage and update through realtime invalidation.
6. Mark notifications read and archive them.
7. Match a pull request's repository to a Reins project by normalized Git remote.
8. Start a review session with a focused initial prompt and navigate to it.
9. Restore the plugin page and counts after Reins or the plugin reloads.
10. Fail without making sessions and projects inaccessible.

If the proposed interfaces cannot support this without Spoke-specific host branches, the interfaces are not ready.

## Possible implementation slices

### 1. Resolve the app mounting seam

Design the app/accessory mount lifecycle at least twice. Compare a Custom Element contract, a host-container mount function, and a declarative or message-based adapter. Record the trust and same-process decision in an ADR if it becomes durable.

### 2. Add host-owned app navigation

Implement the pinned-app sidebar region, app routes, desktop/mobile workspace behavior, fallback UI, and an internal fixture app. Keep discovery and packaging out of this slice.

### 3. Add plugin backend foundations

Implement lifecycle ownership, scoped settings/storage, background services, typed RPC, realtime events, and logging. Exercise them through a built-in fixture using the same seams intended for loaded plugins.

### 4. Build Spoke against the seams

Port the BB Spoke behavior without adding GitHub-specific branches to the host. Add only narrow general Reins capabilities demonstrated by the application.

### 5. Externalize local plugin loading

Define a versioned manifest and local development/install workflow. Dynamically load independent frontend and backend bundles, validate their registrations, and support reload/disposal. Keep plugins explicitly trusted.

### 6. Generalize only from evidence

After at least two real plugin apps, evaluate pinning/reordering, additional app context, a shared UI kit, permissions, stronger isolation, packaging, upgrades, and distribution.

## Explicit non-goals for the first version

- arbitrary replacement of the project/session sidebar
- timeline, tool-renderer, composer, diff, or settings-panel slots
- provider/runtime plugins
- a plugin marketplace
- security sandboxing or permission enforcement
- iframe apps
- remote plugin execution
- arbitrary docking or tiling
- stable public SDK compatibility before the interfaces have been exercised
- requiring plugins to use Lit, Tailwind, or any particular component library

## Open questions

1. **Frontend mount interface:** Custom Element, mount function, or another framework-neutral representation?
2. **Style isolation:** Shadow Root, generated CSS scoping, or trusted shared document styles?
3. **Dependency ownership:** Should every plugin bundle React/Lit and its UI library, or may it consume carefully versioned host externals?
4. **App workspace:** Should desktop apps span every column to the right of the sidebar, or retain any host toolbar/file pane?
5. **Accessory constraints:** What size, update frequency, accessibility text, and failure rules apply to sidebar accessories?
6. **Installation roots:** User-global plugins, project-local plugins, or both? Which wins on duplicate IDs?
7. **Backend authority:** Is the honest trusted-code warning sufficient for local Reins, and what installation confirmation is required?
8. **Database model:** One SQLite file per plugin or namespaced tables/connections inside the Reins database?
9. **Background policy:** How are startup, retries, wakeups, idle behavior, and shutdown bounded?
10. **Versioning:** Which manifest and capability versions gate activation before a supported SDK exists?
11. **Tauri:** Does dynamic frontend loading require CSP, asset-protocol, or updater changes in the remote-webview wrapper?
12. **Testing:** What conformance harness lets plugin authors exercise lifecycle, RPC, storage, and app registration without starting all of Reins?

## Relationship to the broader extension direction

This plan is the first concrete application surface under `docs/dev/extension-architecture.md`. It deliberately does not answer the entire extension problem. New extension points should not be added merely because the loader exists; each capability still needs its own small Reins-owned interface and evidence from a real adapter.

The target outcome is not "Reins can be configured in every way." It is that adjacent applications can be developed and removed independently while the host retains navigation, lifecycle, and core agent-workflow coherence.
