# Extensions

An **extension** adds to Reins only through its SDKs: a backend part (tools for agents, system prompt sections, `api` functions, HTTP methods and pages, its own data) and a frontend part (views, message decorators, `/` commands, a Settings page). An extension can have one part or both. The built-in extensions today are MCP servers ([mcp-servers.md](mcp-servers.md)), the file viewer, file references in messages, and the `/compact` and `/new` commands. Developer docs: [server-sdk.md](../dev/server-sdk.md), [reins-sdk.md](../dev/reins-sdk.md).

## Settings → Extensions

**Settings → Extensions** (`#/settings/extensions`) lists every extension, by label. Reins draws this section, not the extensions: an extension's own Settings page (`#/settings/extensions/<name>`, such as MCP's) shows only what the extension draws.

Each extension is a card with its icon, its label, whether it **loaded** or **failed** (a failed card has a red border), and its description when it has one. Click a card to open the extension's page (`#/settings/extensions/<name>/details`). **Extensions** at the top of that page returns to the list. On the page:

- Its label and name, its description and its status. A failed extension shows what stopped it:

  - **Backend: its directory or database could not be opened**, **Backend: a migration failed** or **Backend: its register function threw**, with the error. A failed backend part registers nothing in that run of the server. The next server reload or restart tries again.
  - **Frontend: its register function threw**, with the error. The other extensions still load.
- **Open its settings**, when the extension has its own Settings page.
- **For agents**: its tool providers, by title (**Tool providers: MCP servers**; the number of tools is not shown, as that can need a call to a remote server), how many system prompt sections it adds, and its `api` functions.
- **In the app**: its `/` commands, its views, how many message decorators it has, and whether it has a Settings page.
- **Storage**: its data directory, the size of its database (with its WAL file), and how many secrets it keeps. Their names and values are never shown.
- **Recent errors**: errors the backend part reported after it loaded (for example a tool left out because its ID breaks the rules, or a system prompt section that failed), the newest first, at most 10. They are kept until the server reloads.

The page shows only what agents and users meet. What is internal to the extension (its migrations, the HTTP methods its own frontend calls, its callback pages) is not shown; the server's report (`GET /api/extensions`) still has it.

The section shows what is registered now: a registration an extension removed is gone. The backend's part is loaded each time you open the section. If it cannot be loaded, the section says so and still lists the frontend parts.

The section is read-only: there is no switch to turn an extension off yet.
