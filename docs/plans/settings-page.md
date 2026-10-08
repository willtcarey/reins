# Settings page

Settings is a single narrow overlay that stacks API keys, the default and utility models, and nodes in one scroll. It mixes tasks of very different frequency and weight (switching the default model, rotating a credential, pairing or revoking a machine), it cannot be linked to, and it has no room for the per-node and per-plugin pages that are planned.

## What people come to settings for

| Goal | How often | What it needs |
|---|---|---|
| First run: get a working model | Once | Add a provider, then pick a default. Order matters. |
| Switch the default model | Fairly often | The model picker, immediately. |
| Fix credentials: rotate a key, re-sign-in, see why sessions fail | Rare, often urgent | The provider list and each key's source. |
| Add a machine | Rare | A focused, time-limited flow whose code is shown once. |
| Troubleshoot or remove a machine | Rare; removal and revoke are security-critical | Node status and a deliberate, confirmed removal (revoke once the node holds sources). |
| Configure a plugin (later) | Rare | A page per plugin. |

## Design (decided)

Settings becomes a routed full-screen page, like project History, organized into sections by intent:

```
#/settings              desktop: section nav + the first section; mobile: the section list
#/settings/models       Default model, Utility model, then Providers
#/settings/nodes        Node list and Add node
#/settings/nodes/:id    (with node sources) details, sources, revoke
#/settings/plugins/:id  (with plugins)
```

- **Desktop:** a left section nav beside the section content.
- **Mobile:** the section list, tapping into a section; the header's back returns to the list.
- **Models and Providers share a section.** Providers decide which models can be picked, so the empty state and its fix belong on one screen. The pickers come first because they are used most; Providers follow, with an explicit **Add provider** button.
- **Nodes** pairs in its own step: Add node replaces the list with the pairing flow (name → code and command, waiting for the machine → paired, back to the list on its own; or expired → another code), so "shown once" is an explicit moment. The code is dropped when you leave the section. The list updates live from node messages. A remote node cannot connect yet, so pairing ends at "paired"; waiting for its first connection belongs between "paired" and the list once it can (node-architecture plan *Remote transport*).
- **Project settings stay with the project.** Where a project lives is chosen in the project form; a node's detail page lists the projects using it, read-only.
- **No empty sections.** About/System appears only when it has content (server build, update status).
- Switching sections replaces the history entry, so Back (and the page's close button) leaves settings in one step. Opening settings from inside the app returns there on close; a settings URL opened directly closes to the workspace.

## Steps

- [x] **Routed page:** `#/settings` and `#/settings/:section` with Models and Nodes, the section nav and mobile list, Add provider as a labeled button, the pairing flow as its own step, and copy that no longer depends on position ("above"). The overlay is removed; the sidebar gear opens the page.
- [x] **Pairing feedback and removal:** the pairing step waits visibly for the machine, shows "Paired as …" and returns to the list, or offers another code when it expires; the node list updates live (`node_paired`, `node_updated`, `node_removed`); paired nodes can be removed for good.
- [x] **One action in the node list:** Remove, confirmed in its row (no native `confirm()`: the Mac app's webview shows no JavaScript dialogs). Revoke left the list: until a node holds project sources it differs from Remove only in keeping a record.
- [ ] **Node detail pages** with node sources (node-architecture plan *Node-owned sources*, *Node management screen*); Revoke (`POST /api/nodes/:id/revoke`, kept in the API and client) returns there, for a node that holds sources and so cannot be removed.
- [ ] **Plugin sections** with pinned plugin apps.
