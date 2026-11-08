# Extensions

An **extension** adds to Reins only through its SDKs: a backend part (tools for agents, image models for agents, system prompt sections, script functions (`reins.<namespace>` in `execute`), HTTP methods and pages, its own data) and a frontend part (views, shown in the Inspector, in messages or as the main area's page with a link of their own, message decorators, `/` commands, sidebar sections, a Settings page). An extension can have one part or both. The built-in extensions today are MCP servers ([mcp-servers.md](mcp-servers.md)), OpenAI images (image models of OpenAI-compatible image APIs, [images.md](images.md)), automations (schedules and commands that wake sessions, [automations.md](automations.md)), the file viewer, file references in messages, the `/compact` and `/new` commands, Recent sessions (the sidebar's Recent section, with a backend part that decides which sessions are recent) and the sidebar's Projects section ([sidebar.md](sidebar.md)). Developer docs: [server-sdk.md](../dev/server-sdk.md), [reins-sdk.md](../dev/reins-sdk.md).

## Turning one off

Any extension can be turned off, a built-in one too: the Projects section, the file viewer, `/compact`, MCP. Choose **Turn off** on its page in Settings → Extensions, or run `reins extension disable <name>`. Reins stops it at once (its background work stops, and open browsers drop what it added: its sidebar section, its views, its commands, its Settings page), and it stays off when Reins restarts. Its data stays. **Turn on** (or `reins extension enable <name>`) loads it again. `reins extension list` shows every extension, with `disabled` for one that is off.

## Your own extensions

An extension can also live outside Reins, in any directory on the server's machine: you build it, `reins extension add <dir>` records it, and Reins loads its built files, at once and at every start. After you build it again, `reins extension reload <name>` loads it anew without restarting Reins (its background work restarts, and open browsers load its new frontend part); `reins extension remove <name>` stops loading it and keeps its data. How to write one: [building-extensions.md](building-extensions.md). Such an extension runs with Reins' full trust: add only code you trust.

## Settings → Extensions

**Settings → Extensions** (`#/settings/extensions`) lists every extension, by label. Reins draws this section, not the extensions: an extension's own Settings page (`#/settings/extensions/<name>`, such as MCP's) shows only what the extension draws.

Each extension is a card with its icon, its label, whether it **loaded**, is **loading** (one of yours being loaded), **failed** (a failed card has a red border) or is **disabled** (turned off, a grey dot), its description cut to two lines (hover it to read all of it), and where it came from: its directory, or **Built in**. All cards are the same size; its services and the rest are on its page. The section reads the server again when an extension is added, reloaded, removed, or turned on or off. Click a card to open the extension's page (`#/settings/extensions/<name>/details`). **Extensions** at the top of that page returns to the list. On the page:

- Its label and name, its description and its status, and **From**: *Built into Reins*, or the directory it was added from, with its **Version**. Every extension has **Turn off** (or **Turn on**: *Turning one off*). One you added has **Reload** (build it again and load it anew; not while it is off) and **Remove** (after a confirmation: Reins stops loading it, and its directory, data and secrets stay). A built-in one cannot be removed, only turned off.
- A failed extension shows what stopped it:

  - **Backend: its manifest is invalid** or **Backend: its files could not be loaded** (yours only: a file the manifest names is missing, so build it, or its module threw), with the error: fix it and choose Reload.

  - **Backend: its directory or database could not be opened**, **Backend: a migration failed** or **Backend: its register function threw**, with the error. A failed backend part registers nothing in that run of the server. The next server reload or restart tries again.
  - **Frontend: its register function threw**, with the error (for yours, also when its frontend module could not be loaded). The other extensions still load.
  - **Frontend: it failed in a browser**, with the error and its stack: one of yours failed in another browser (a phone, say), which told the server. It goes once a browser loads it, or you reload it. `reins extension list` shows it too.
- **Open its settings**, when the extension has its own Settings page.
- **For agents**: its tool providers, by title (**Tool providers: MCP servers**; the number of tools is not shown, as that can need a call to a remote server), how many system prompt sections it adds, and its `api` functions.
- **In the app**: its `/` commands, its views, its sidebar sections, how many message decorators it has, and whether it has a Settings page.
- **Services**: the backend part's long-running work (polling, a queue), which Reins starts and stops. Each shows its state, with a status dot: **starting**, **running** (green), **restarting** (it crashed: Reins starts it again after a wait, 1 s doubling to 5 min, and shows the next attempt), **stopped**, or **failed** (it did not stop in time, so Reins does not start it again until the server reloads or restarts). With it: since when, how many restarts, and its last error. A server reload or restart stops each service and starts it again.
- **Sessions**: how many listeners it has for the ends of the runs of sessions it started ("Run ends heard"), when it has any. An extension can start sessions (often hidden ones, in any directory on a node, with or without a project) and send messages to sessions; the chat shows "sent from <extension>" under such a message (click it to open the details the extension gave the model, when there are any), and the session list "from <extension>" under a session it started.
- **Storage**: its data directory, the size of its database (with its WAL file), and how many secrets it keeps. Their names and values are never shown.
- **Recent errors**: errors the backend part reported after it loaded (for example a tool left out because its ID breaks the rules, or a system prompt section that failed), the newest first, at most 10. They are kept until the server reloads.

Its **HTTP** group lists the backend part's HTTP methods (`POST /api/extensions/<name>/<method>`: what its frontend part, scripts and `@reins/client` call) and its pages (`GET /extensions/<name>/…`, such as an OAuth callback). Its migrations are not shown; the server's report (`GET /api/installed-extensions`) has them.

The section shows what is registered now: a registration an extension removed is gone. The backend's part (services' states included) is loaded each time you open the section: it does not update while open. If it cannot be loaded, the section says so and still lists the frontend parts.

Extensions are added with the CLI, not from this section.
