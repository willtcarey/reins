# Extensions

An **extension** adds to Reins only through its SDKs: a backend part (tools for agents, image models for agents, system prompt sections, script functions (`reins.<namespace>` in `execute`), HTTP methods and pages, its own data) and a frontend part (views, shown in the Inspector, in messages or as the main area's page with a link of their own, message decorators, `/` commands, sidebar sections, a Settings page). An extension can have one part or both. The built-in extensions today are MCP servers ([mcp-servers.md](mcp-servers.md)), OpenAI images (image models of OpenAI-compatible image APIs, [images.md](images.md)), automations (schedules and commands that wake sessions, [automations.md](automations.md)), the file viewer, file references in messages, the `/compact` and `/new` commands, Recent sessions (the sidebar's Recent section, with a backend part that decides which sessions are recent) and the sidebar's Projects section ([sidebar.md](sidebar.md)). Developer docs: [server-sdk.md](../dev/server-sdk.md), [reins-sdk.md](../dev/reins-sdk.md).

## Settings → Extensions

**Settings → Extensions** (`#/settings/extensions`) lists every extension, by label. Reins draws this section, not the extensions: an extension's own Settings page (`#/settings/extensions/<name>`, such as MCP's) shows only what the extension draws.

Each extension is a card with its icon, its label, whether it **loaded** or **failed** (a failed card has a red border), its description when it has one, and the state of each of its services, with a status dot. Click a card to open the extension's page (`#/settings/extensions/<name>/details`). **Extensions** at the top of that page returns to the list. On the page:

- Its label and name, its description and its status. A failed extension shows what stopped it:

  - **Backend: its directory or database could not be opened**, **Backend: a migration failed** or **Backend: its register function threw**, with the error. A failed backend part registers nothing in that run of the server. The next server reload or restart tries again.
  - **Frontend: its register function threw**, with the error. The other extensions still load.
- **Open its settings**, when the extension has its own Settings page.
- **For agents**: its tool providers, by title (**Tool providers: MCP servers**; the number of tools is not shown, as that can need a call to a remote server), how many system prompt sections it adds, and its `api` functions.
- **In the app**: its `/` commands, its views, its sidebar sections, how many message decorators it has, and whether it has a Settings page.
- **Services**: the backend part's long-running work (polling, a queue), which Reins starts and stops. Each shows its state, with a status dot: **starting**, **running** (green), **restarting** (it crashed: Reins starts it again after a wait, 1 s doubling to 5 min, and shows the next attempt), **stopped**, or **failed** (it did not stop in time, so Reins does not start it again until the server reloads or restarts). With it: since when, how many restarts, and its last error. A server reload or restart stops each service and starts it again.
- **Sessions**: how many listeners it has for the ends of the runs of sessions it started ("Run ends heard"), when it has any. An extension can start sessions (often hidden ones, in any directory on a node, with or without a project) and send messages to sessions; the chat shows "sent from <extension>" under such a message (click it to open the details the extension gave the model, when there are any), and the session list "from <extension>" under a session it started.
- **Storage**: its data directory, the size of its database (with its WAL file), and how many secrets it keeps. Their names and values are never shown.
- **Recent errors**: errors the backend part reported after it loaded (for example a tool left out because its ID breaks the rules, or a system prompt section that failed), the newest first, at most 10. They are kept until the server reloads.

Its **HTTP** group lists the backend part's HTTP methods (`POST /api/extensions/<name>/<method>`: what its frontend part, scripts and `@reins/client` call) and its pages (`GET /extensions/<name>/…`, such as an OAuth callback). Its migrations are not shown; the server's report (`GET /api/extensions`) has them.

The section shows what is registered now: a registration an extension removed is gone. The backend's part (services' states included) is loaded each time you open the section: it does not update while open. If it cannot be loaded, the section says so and still lists the frontend parts.

The section is read-only: there is no switch to turn an extension off yet.
