# Settings

REINS stores global configuration in its SQLite database.

Open settings with the gear in the sidebar. Settings is a full page with sections:

- **Models**: the default and utility models, and the providers that supply them.
- **Nodes**: the machines that run sessions.

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

- It is global to the server, not per-project. The server picks the model; the work itself runs on the project's node, which needs credentials for that model's provider like any session.
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

API keys and OAuth sign-in are managed under **Providers** in **Settings → Models**: **Add provider** offers the providers not yet configured, and each configured one shows where its credential comes from (`env`, `stored`, `oauth`, `local`). Replacing or removing a key, or signing in or out, takes effect on connected nodes from their next model request; a node that was offline picks it up when it reconnects.

## Nodes

**Settings → Nodes** lists every node: its name, its hostname, and whether it is connected, offline or revoked. The node that runs alongside the server is marked **local**.

The list stays current while you look at it: a node's status changes as it connects or disconnects, and nodes paired, revoked or removed elsewhere appear, change or disappear.

- **Add node** replaces the list with the pairing steps: it asks for an optional name (the node's hostname is used otherwise), then shows a pairing code and the one-line command to run on the machine you are adding (Linux or macOS): `curl -fsSL <server URL>/nodes/install | sh -s -- <code>`, which installs the node, pairs it and starts it. Append `--source <path>` for each checkout it should serve. See [nodes.md](nodes.md) for what it installs and how to run the node.
- While the code is shown, a pulsing dot says **Waiting for the machine to pair…**. Once the machine runs the command, the page says **Paired as <name>** with a check, and waits, with no time limit, for the new node to connect: a pulsing dot says **Waiting for <name> to connect…**, above the command to run on the machine again if it does not. Once the node connects (or straight away, if it already has), the page says **<name> is connected** and a moment later returns to the list, with the new node in it. **Done** returns to the list at any point; the node stays paired.
- The code works once and expires after 10 minutes. If it expires unused, the page says so and offers **Create another code**. The code is shown only until you click **Cancel** or leave the section; if you lose it, create another.
- The code ends up in that machine's shell history. That is harmless: once used or expired it pairs nothing.
- **Remove** deletes a paired node, revoked or not. A dialog first asks you to confirm, saying that this is permanent; **Cancel** (or Escape) keeps the node. Once removed, it is disconnected, refused from then on (the node stops trying to connect, rather than retrying) and gone from the list for good; to use that machine again, pair it again. A node that still holds a project's checkout cannot be removed; the message names the projects. The local node cannot be removed.
- Revoking a node (refusing it but keeping its record, for when it holds project checkouts) is not offered on this page; it will come with a page per node. A node revoked through the API shows as **revoked**, can be removed, and is not offered when adding a project.

### Sources

A paired node works only in the checkouts declared on its machine: pass `--source <path>` to the install command, or run `~/.reins/bin/reins node source add <path>` there (an existing directory; `reins node source remove <path>` stops serving it, `reins node source list` shows them; [nodes.md](nodes.md)). A running node reports a change within moments; one that is offline reports it when it next connects. The node refuses any other path, so a project or session pointed at an undeclared checkout on it fails with "Not a source of this node". The local node is not restricted: it serves any path on the server's machine.

Under each node, **Settings → Nodes** lists its checkouts, also while it is offline (as it last reported them):

- a checkout that belongs to a project shows the project's name;
- a checkout the node declares that no project has yet offers **Attach to project**: a dialog asks which existing project, and attaching makes it one of that project's checkouts (the node confirms the directory first; a checkout belongs to one project only);
- a project's checkout that the node no longer declares is marked **not declared on the node**: work there is refused until it is declared again;
- a paired node with no checkouts says how to declare one.

## Per-session model changes

Each chat session has its own **Session model** control near the message composer.

- It changes the model for the current session only.
- It does not modify the global default used for future sessions.
- It can change both the selected model and the thinking level for the session.
- The change applies on the next turn if a response is already in flight.
- It includes a shortcut to apply the current global default model to the session.

Changing a session model only affects that session, not the global default. Every other open window showing the session picks up the new model right away.

If the session is currently open, the change is applied live for the next LLM turn. If the session is inactive, REINS stores the new model so it takes effect the next time the session is used.
