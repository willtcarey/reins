# ADR-034: Sources Belong to No Project; a Session's Project Is Optional

- **Status:** Accepted
- **Date:** 2026-11-01
- **Author:** Will (with Claude)
- **Revises:** [ADR-026](026-sources-managed-on-the-server.md) (sources managed from the project, a checkout to one project, a project to one checkout per node)
- **Plan:** [session-locations.md](../plans/session-locations.md) phases 1 and 2

## Context

A source did three jobs: where a session works (a node and a path), where a project lives on each node (at most one per node, chosen in the project form, used by Move and as the default), and a claim that a checkout belongs to one project (`sources.project_id`, `(node_id, path)` unique, triggers making a session's source its project's). Only the first is needed:

- Every view of a checkout is reached from a session, but read the project's default source, so a session moved to another node showed the wrong checkout.
- Registering a checkout per node before a session could go there (the project form's *Add a source*, `reins source add`) was ceremony, and one checkout per node ruled out worktrees per task and scratch directories.
- `api.nodes.*` already treats a node and a path as the unit of work.

The coming automation extension also needs sessions that belong to no project: daily "heartbeat" sessions that run in a directory (a notes vault, a home directory) that is no project's, hidden from the browser.

## Decision

**A source is a location**: a `(node_id, path)` row, unique, with no project. It is made on first use (`ensureSource`: a new one needs an absolute path, a node that is not removed and the node confirming a directory there; a known one is returned without its node), used by any session, never managed by the user. The name stays "source". Two projects may use one directory.

**A project has a default source** (`projects.default_source_id`): where it was created, where its new sessions work unless they inherit better (a parent's source, the task's most recent session's), and the checkout of the project operations no session makes (task lists' diff stats, deleting a task's branch). It is a default, not a limit: the new session page offers any directory on any node, a session moves anywhere, and a task's branch is made by its sessions' runs where they work, not where the task was created. Uploads go through the file browser into the open session's checkout, and skill suggestions are those of a location. The project form edits it as one node and path; changing it moves no session.

**A session has a source and optionally a project.** `sessions.source_id` is required and `sessions.project_id` nullable; a task needs its project (a `CHECK`). A session of no project:

- names its source when it is created (nothing to inherit), `POST /api/sessions {source}` or `createSession(state, {sourceId})`, no `projectId`;
- gets no project section in its system prompt (neither a task nor the project assistant's role): its context comes from its source (AGENTS.md, skills, the environment);
- lists and starts, by default, **the sessions of no project on its source** (`sessions.list()`, `sessions.start`; later, scripts lost their scope rules, so `send`, metadata, `setModel` and `compact` reach any session); tasks, code reviews and `create_task` refuse it, and `projects.current()` is null;
- reads its checkout views like any session, its diffs against `HEAD` (no base branch).

**Checkout views follow the session** (phase 1): files, diffs, git and skills are `/api/sessions/:sessionId/…`, reading the session's source.

**Move is "a node and a path"** (`POST /api/sessions/:id/move {nodeId, path}`, through `ensureSource`); its targets list every node not removed with the paths the project's sessions used there.

**Removed:** the project form's Sources section and *Add a source*, `GET/POST /api/projects/:id/sources`, `PATCH /api/projects/:id/sources/:sourceId` (`moveSource`), `DuplicateSourceError` and the one-per-node rule, `listNodesForProject`, the `session_source_*` triggers and `reins source add`. `reins source list` stays, listing the sources in use with the projects using them.

**One migration, no compatibility path** (`062_sources_without_projects`): each project gets as its home source (`home_source_id`, renamed `default_source_id` by migration 064: a default, not a limit) the default source it had until then (the first on a node not removed, else its first); `sources` and `sessions` are rebuilt under their IDs with foreign keys checked before commit. It was run on a copy of a live database (3 165 sessions, 48 sources) before it shipped: every session, message and Pi value kept, each project's new default source its old one.

## Options considered

- **Keep `sources.project_id`, add sources freely per project.** Rejected: it keeps the claim nobody needs and a second row for a directory two projects share.
- **Sessions of no project in a hidden "system" project.** Rejected: a project brings a default source, tasks, code reviews and a sidebar entry that such a session does not have; a fake project would be listed or special-cased everywhere.
- **`sessions.list()` from a session of no project requires an explicit filter.** Rejected for a default list: the sessions on its own source are what an automation's runs need to find each other.

## Consequences

- A session moved to another node shows that node's checkout; a session can work in any directory, a project's default source or not.
- What a project "has on node X" is derived (the sources its sessions used there), for suggestions only.
- Sources nobody uses stay as rows (tiny; not listed). Deleting a project deletes its sessions and keeps the sources.
- A runtime alive across the reload that applies the migration runs old code that checks `sources.project_id`: apply it with no session running and restart the server.
- Open: task lists' diff stats read the default source (each task's latest session's would be better); relocating a checkout on disk now means moving each session; the browser has no UI to create a session of no project (the sidebar's *Other sessions* only lists them).
