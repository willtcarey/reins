# Settings

REINS stores global configuration in its SQLite database.

Open settings with the gear in the sidebar. Settings is a full page with sections:

- **Models**: the default and utility models, and the providers that supply them.
- **Nodes**: the machines where sessions work, on projects' files.

On a wide screen the sections are listed down the left; on a phone you pick one from a list, and the back arrow returns to the list. Each section has its own address (`#/settings/models`, `#/settings/nodes`), so it can be linked to and survives a reload. The back arrow (or the browser's Back) leaves settings in one step, to wherever you opened it from, however many sections you visited.

## Default model

The **Default Model** setting controls which model new sessions use.

- It is global to the server, not per-project.
- It applies to newly created sessions only.
- Existing sessions keep their current model unless changed explicitly.
- Models run through the registered [AgentHarness Pi runtime](runtimes.md).
- A default model must be configured before creating a session without an explicit model override.
- If a default model is configured but no longer exists, new sessions fail with an error until you update the setting.

You can change the default model under **Settings → Models** using a single provider/model picker. The runtime refreshes model catalogs from Pi, so newly published models can appear without a Reins release; when offline, it uses Pi's bundled and last cached catalogs.

## Utility model

The **Utility Model** setting controls which model REINS uses for lightweight internal tasks: today, generating a task's title, description and branch name from your description.

- It is global to the server, not per-project. The server runs it with its own credentials, like every session's model; it needs no node.
- It is intended for cheaper and faster one-shot calls.
- If no utility model is configured, REINS falls back to the default model.
- If neither is configured, task generation skips the model and uses your text as the task's title and description.

You can configure it under **Settings → Models**, below the default model.

## Auth credentials

Provider auth credentials are stored separately from general settings.

- App settings like the default model are stored separately from provider credentials.
- Stored credentials are encrypted at rest.
- Environment variables like `ANTHROPIC_API_KEY` still work as fallbacks when no database credential is configured.
- Database-managed API keys take precedence over environment variables.

API keys and OAuth sign-in are managed under **Providers** in **Settings → Models**: **Add provider** offers the providers not yet configured, and each configured one shows where its credential comes from (`env`, `stored`, `oauth`, `local`). Replacing or removing a key, or signing in or out, takes effect for every session from its next model request. Credentials stay on the server: nodes never receive them.

## Nodes

**Settings → Nodes** lists every node: its name, its hostname, whether it is connected, offline or revoked, and how many sources it holds ("12 sources", or "No sources"). A **source** is a project's working copy on a node. The node that runs alongside the server is marked **local**. A node installing the server's new code and restarting on it after a server upgrade is marked **updating…** until it is back ([nodes.md](nodes.md) *Updates*); one running other code than the server's, because the server could not build its own, is marked **old build**. An offline node whose last attempt to connect reached the server but failed says why under its name (**Can't connect: …**, e.g. when it and the server speak different protocol versions), until it connects.

The list stays current while you look at it: a node's status changes as it connects or disconnects, and nodes paired, renamed, revoked or removed elsewhere appear, change or disappear.

- **Add node** replaces the list with the pairing steps: it asks for an optional name (the machine's name is used otherwise, [nodes.md](nodes.md) *Its name*), then shows a pairing code and the one-line command to run on the machine you are adding (Linux or macOS): `curl -fsSL <server URL>/nodes/install | sh -s -- <code>`, which installs the node, pairs it and starts it. Then add its sources from a project ([projects.md](projects.md)). See [nodes.md](nodes.md) for what it installs and how to run the node.
- While the code is shown, a pulsing dot says **Waiting for the machine to pair…**. Once the machine runs the command, the page says **Paired as <name>** with a check, and waits, with no time limit, for the new node to connect: a pulsing dot says **Waiting for <name> to connect…**, above the command to run on the machine again if it does not. Once the node connects (or straight away, if it already has), the page says **<name> is connected** and a moment later returns to the list, with the new node in it. If the new node is removed meanwhile (from another window), the page returns to the list. **Done** returns to the list at any point; the node stays paired.
- The code works once and expires after 10 minutes. If it expires unused, the page says so and offers **Create another code**. The code is shown only until you click **Cancel** or leave the section; if you lose it, create another.
- The code ends up in that machine's shell history. That is harmless: once used or expired it pairs nothing.
- **Rename** changes the name a node is shown with, any node, the local one included: a dialog asks for the new name (1 to 100 characters); **Save** (or Enter) renames it, **Cancel** (or Escape) keeps the old one. The list, the project form and the move dialog show the new name; a session's menu ("Node: <name>") shows it once that session next changes, or after a reload.
- **Remove** removes a paired node, revoked or not, also one that holds projects' sources. A dialog first asks you to confirm, saying that this is permanent and that its sessions stay readable; **Cancel** (or Escape) keeps the node. Once removed, it is disconnected, refused from then on (the node stops trying to connect, rather than retrying) and gone for good: from this list, the project form (its node choices, **Add a source**, and the sources it lists) and the session move dialog. Its sources are no longer a project's default, so new sessions start on the project's next source. Sessions that ran on it keep their history and can still be read: their menu shows "Node: <name> (removed)" (from the session's next change, or after a reload). They take no new work: a prompt, a model change or a resume is refused with "This session's node was removed; move it to another node to continue", and work still waiting for the node when you removed it fails with the same message. A run still going on it is ended as interrupted. **Move to node…** moves such a session to another node holding a source of its project, where it continues. To use that machine again, pair it again: it becomes a new node ([nodes.md](nodes.md)). The local node cannot be removed.
- Revoking a node (refusing it but keeping its record, for when it holds project sources) is not offered on this page; it will come with a page per node. A node revoked through the API shows as **revoked**, can be removed, and is not offered when adding a project.

A node's sources are added to a project, not to a node: when you create a project on that node, or with **Add a source** in the project's settings ([projects.md](projects.md)). A node keeps no list of its own; it works in whichever of its directories a project's source names. `reins source list` lists them ([nodes.md](nodes.md) *Sources*).

## Per-session model changes

Each chat session has its own **Session model** control near the message composer.

- It changes the model for the current session only.
- It does not modify the global default used for future sessions.
- It can change both the selected model and the thinking level for the session.
- The change applies on the next turn if a response is already in flight.
- It includes a shortcut to apply the current global default model to the session.

Changing a session model only affects that session, not the global default. Every other open window showing the session picks up the new model right away.

If the session is currently open, the change is applied live for the next LLM turn. If the session is inactive, REINS stores the new model so it takes effect the next time the session is used.
