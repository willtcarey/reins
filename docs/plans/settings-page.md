# Settings page

Settings is a single narrow overlay that stacks API keys, the default and utility models, and nodes in one scroll. It mixes tasks of very different frequency and weight (switching the default model, rotating a credential, pairing or revoking a machine), it cannot be linked to, and it has no room for the per-node and per-plugin pages that are planned.

## What people come to settings for

| Goal | How often | What it needs |
|---|---|---|
| First run: get a working model | Once | Add a provider, then pick a default. Order matters. |
| Switch the default model | Fairly often | The model picker, immediately. |
| Fix credentials: rotate a key, re-sign-in, see why sessions fail | Rare, often urgent | The provider list and each key's source. |
| Add a machine | Rare | A focused, time-limited flow whose code is shown once. |
| Troubleshoot or remove a machine | Rare; revoke is security-critical | Node status and a deliberate revoke. |
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
- **Nodes** pairs in its own step: Add node replaces the list with the pairing flow (name → code and command → Done), so "shown once" is an explicit moment. The code is dropped when you leave the section.
- **Project settings stay with the project.** Where a project lives is chosen in the project form; a node's detail page lists the projects using it, read-only.
- **No empty sections.** About/System appears only when it has content (server build, update status).
- Switching sections replaces the history entry, so Back (and the page's close button) leaves settings in one step. Opening settings from inside the app returns there on close; a settings URL opened directly closes to the workspace.

## Steps

- [ ] **Routed page:** `#/settings` and `#/settings/:section` with Models and Nodes, the section nav and mobile list, Add provider as a labeled button, the pairing flow as its own step, and copy that no longer depends on position ("above"). The overlay is removed; the sidebar gear opens the page.
- [ ] **Node detail pages** with node sources (node-architecture plan *Node-owned sources*, *Node management screen*); Revoke moves there.
- [ ] **Plugin sections** with pinned plugin apps.
