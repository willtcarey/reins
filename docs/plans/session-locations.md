# Sessions pick where they run; sources stop belonging to projects

Status: **agreed direction, not started** (2026-10-20). Supersedes, in [node-architecture.md](node-architecture.md), *Choosing a session's node*, the source picker of *Node management screen*, and the "several sources of a project on one node" part of *Compute nodes and kinds of source*. Revises [ADR-026](../adr/026-sources-managed-on-the-server.md) (sources managed from the project) and the one-source-per-node rule; write the ADR when phase 2 lands.

## Why

A source does three jobs today: it is **where a session works** (a node and a path), **where a project lives on each node** (at most one per node, chosen in the project form, used by Move to node and as the default), and **a claim that a checkout belongs to one project** (`(node_id, path)` unique, `sources.project_id`). Only the first is a fully formed idea:

- Where a project "lives" matters only to sessions, and every view that reads a checkout (file browser, diffs, branch indicator) is reached from a session. Those routes read the project's *default* source instead (`requestProject` in `routes/index.ts`), so a session moved to another node shows the wrong checkout: a bug the current model invites.
- Registering a checkout per node before a session can go there is ceremony (project form → *Add a source*, `reins source add`), and the one-per-node rule rules out worktrees per task and scratch directories.
- Node file and command access (`api.nodes.*`, scripting.md *Files and commands on any node*) already treats "a node and a path" as the unit of work.

## Direction

- **A source is a location**: a `(node_id, path)` row, unique, with **no project**. It is a denormalized name for a place, created on first use (get-or-create), never managed by the user. The name stays "source".
- **Sessions keep `source_id`.** A session belongs to its project (and task) as now; its source says only where its tools, checkout preparation and environment discovery run.
- **A project has a home source** (`projects.home_source_id`): where it was created, the default for a session with nothing better to inherit, and the checkout for the few project-level operations that have no session (below). The project form edits it as one node + path field; changing it moves no sessions.
- **"Where does this project live on node X"** is derived, not stored: the sources this project's sessions have used on X (`sessions JOIN sources WHERE project_id = ?`). It feeds suggestions in the pickers, nothing else.
- **A checkout no longer belongs to one project.** Two projects in one directory is odd but harmless.
- **You pick where a session runs before it starts.** That needs sessions to be created on their first message, not on the plus button (phase 3).

## Phases

### 1. Checkout views follow the session (independent; fixes the bug above)

- [ ] The routes that read a checkout take the session they are viewed from: files (`/files`, `/files/tree`, `/files/content`), diffs (`/diff/files`, `/diff/patch`), git (`/git/spread`, `/git/push`, `/git/rebase`), upload and skills. Proposed: move them under `/api/sessions/:sessionId/…` with a session middleware giving `ProjectModel` in the session's source (`ctx.models.project(projectId, sourceId)` already takes one). Code-review routes stay project-scoped unless they read the checkout.
- [ ] Frontend: the workspace store passes the open session; the project menu's **Upload files** either goes to the session view or uses the home source (decide).
- [ ] Tests: a session on a second node reads that node's checkout, not the default source's.

### 2. Sources without projects

Migration (one, no compatibility path):

- [ ] Rebuild `sources` without `project_id`, keeping `UNIQUE (node_id, path)`; projects that shared a checkout path already cannot exist (it was unique), so no rows merge.
- [ ] Drop the `session_source_insert`/`session_source_update` triggers (they enforce source/project match); `sessions.source_id` stays `NOT NULL` in effect (the insert path always sets it).
- [ ] Add `projects.home_source_id`, backfilled from `defaultSource(project)` (the lowest-ID source not on a removed node, else the lowest-ID one).

Server:

- [ ] `ensureSource(nodeId, path, nodes)`: get-or-create by `(node_id, path)`. A new row needs an absolute path, a node that is not removed, and the node confirming a directory there (as `createSource` does now). An existing row is returned without contacting the node, so a known location on an offline node can still be chosen (the work waits, as today).
- [ ] `resolveSource`/`sessionSource` drop the project check: a session's source is `getSource(row.source_id)`. `defaultSource` becomes the project's home source.
- [ ] `createSession` takes a source (ID or `{nodeId, path}`), else inherits: the parent's (scripts, already), then the task's most recent session's, then the project's home.
- [ ] **Move** becomes "Move session…": a node and a path. `sessionMoveTargets` lists nodes (not removed) with the paths this project's sessions have used on each, most recent first; a node with none is still a target (the path is typed). `moveSession` calls `ensureSource` and repoints the session.
- [ ] Project creation: name, base branch and a location; `ensureSource`, then `home_source_id`, then `detectDefaultBranch` in it, as now.
- [ ] Task creation runs its git (create/track the branch, base commit) in the calling session's source (the `create_task` tool, `tasks.create` scripts), else the home source (the task form). Open: create the branch lazily at its first run instead, so a task is not tied to where it was created.
- [ ] Scripting: `projects.create` takes a node and path (already defaults to the caller's node); `sessions.start` may name a source; `nodes.get` lists a node's sources with the projects whose sessions use them. The planned `projects.addSource` is not needed.

Removed:

- [ ] The project form's **Sources** section and *Add a source* (replaced by the home location field), `POST /api/projects/:id/sources`, `PATCH /api/projects/:id/sources/:sourceId` (`moveSource`), `DuplicateSourceError`'s one-per-node rule, `listNodesForProject`, `reins source add`. Keep or drop `reins source list` (decide; it could list locations with the projects that use them).
- [ ] Settings → Nodes: "N sources" becomes the count of sessions on the node, or goes.

### 3. Sessions created on their first message

Today the plus button (project or task) `POST`s a session and navigates to `/session/:id`; the composer then needs that ID for the model picker (`PUT /sessions/:id/model`), attachments (`POST /sessions/:id/attachments`, uploaded at send) and the prompt (WS `prompt`, which requires an existing session). Server-started sessions (`sessions.start`, `startTaskSession`, the task generator) already create and prompt together and are unchanged.

- [x] **Draft view:** the plus buttons and `/new` navigate to `#/new?project=…&task=…` (frontend-architecture.md *Routing*), where the project and task are chosen too, holding a client-only draft: model and thinking level (from the default model setting), the composer's text and attachments. No row exists; nothing is listed in the sidebar (no placeholder row). The location is still to come (next item).
- [ ] **Location picker** in the draft's header, beside the model picker: a node (connected ones first, offline ones marked and still choosable for known paths) and a path, defaulting as `createSession` inherits (task's most recent session, else the home source) and suggesting the project's paths on the chosen node. A path not yet known is checked on the node when the session is created; a refusal shows in the draft, which stays. A directory browser over `fs.list` would help on remote nodes (optional).
- [x] **Send** creates the session with its task and the chosen model (`POST /api/projects/:id/sessions`; a model chosen after a failed send is set with `PUT /sessions/:id/model`), uploads attachments and sends the prompt as now, then replaces the route with `/session/:id`, the message animating into the conversation. A failure after the row exists keeps the session for a retry from the page; leaving the page then leaves it empty. Still to do: the location in the create request. Open: one request that creates and prompts, so a failed send leaves nothing (attachments make that a multipart request). It would also remove the page's retry state (`NewSessionPage.created`: the session kept for another try, and its model), and is the shape the SDK's `sessions.create` needs to take attachments, for the page as an SDK view.
- [ ] Skill suggestions in the draft read the chosen location (`GET /api/nodes/:nodeId/skills?path=…`, or the phase 1 route keyed by source); the model picker needs no session.
- [ ] Once a session has messages its location changes only through Move. On an empty session (created but never prompted) the header's picker is Move.
- [x] A draft's project and task survive a reload (its URL); its text and attachments are lost like an unsent composer's.

Phase 3's draft flow can land before phase 2 with the picker limited to the project's existing sources; the free path needs phase 2.

## Open questions

- **Task lists with no session open:** each open task's diff stats (`Tasks.listWithDiffStats`) are read in the project's default source. Proposed: the task's most recent session's source, else the home source (one git call per distinct source).
- **Relocating a checkout on disk:** today editing a source's path moves every session on it. Without it, each session is moved by hand. Keep an admin "relocate" on a source (Settings → Nodes), or not.
- **Unused sources:** rows no session or project references. Tiny; leave them, or prune on node removal.
- **Non-git locations** (*Compute nodes and kinds of source*): a free location makes a plain directory easy to pick; hiding git views there is still separate work.
- **Worktrees per task:** made possible by free locations (a task's sessions in `.../worktrees/<branch>`), not part of this plan.
