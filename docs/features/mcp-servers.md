# MCP servers

Reins can connect to remote [MCP](https://modelcontextprotocol.io) servers over HTTP. Add them under **Settings → MCP servers** (`#/settings/mcp`), sign in, and check that they connect and which tools they have.

Agents cannot use these tools yet: this page sets the servers up and shows their status. Servers are global to Reins, not per project.

An agent can also add, change, test and remove servers from an `execute` script (`api.mcp`, [scripting.md](scripting.md) *Manage MCP servers*), secrets included. It can start an OAuth sign-in too: it gives you the page to open, and if the page your browser lands on after you approve does not load, you give it that page's address and it completes the sign-in.

## Adding a server

**Add MCP server** opens a form:

- **Name**: lowercase letters, digits and hyphens, starting with a letter (at most 32), unique. The server's tools will be named after it, so pick something short (`executor`, `slack`).
- **Description**: optional; what its tools are for.
- **URL**: the server's MCP endpoint, `http` or `https`, for example `https://executor.example.com/mcp`. Reins uses the streamable HTTP transport, and the older HTTP+SSE transport when the server only speaks that. Servers that run as a local command (stdio) are not supported.
- **Authentication**:
  - **OAuth**: you sign in with the server's own login (below). Reins registers itself with the server's authorization server when that server allows it (dynamic client registration). Under **Advanced**, give a **Client ID** and **Client secret** for a server that needs a client registered beforehand, and a **Scope** to ask for other scopes than the server's own. The redirect URL to register with such a client is shown there: `<Reins URL>/oauth/mcp/callback`.
  - **Header**: Reins sends a fixed header with every request, such as `Authorization: Bearer …` or `X-Api-Key: …`. Give the header's name and value.
  - **None**: the server needs no authentication.

**Edit** opens the same form. Secrets (the header's value, the client secret) are never shown again: a saved one shows as "Saved (leave blank to keep it)"; type a new one to replace it. Changing a server's URL, its authentication or its OAuth client signs it out.

Credentials are stored encrypted in Reins' database, like provider API keys, and stay on the server.

## Signing in (OAuth)

A new OAuth server shows **needs sign-in**. **Sign in** opens the server's login page in a new window. Sign in there and approve Reins; the window shows "Signed in to <name>" and closes itself. The settings page then shows the server connecting and connected, with its tools. If your browser blocked the window, use **Open the sign-in page**.

- A sign-in must be finished within 15 minutes. Starting another one replaces it: the older window then shows that its sign-in is unknown.
- A sign-in survives a Reins reload or restart: finish it in the window you opened.
- Reins refreshes the server's access token when it expires. If the refresh fails (you revoked Reins' access, or the server forgot it), the server shows **needs sign-in** again: sign in again.
- **Sign out** makes Reins forget the server's tokens.

The window must reach Reins at the address you use in the browser: the authorization server sends it back to `<that address>/oauth/mcp/callback`. Some authorization servers accept only `https` redirect URLs, or only ones registered beforehand (Slack's); reach Reins over `https` for those.

## Status and tools

Each server shows a status:

| Status | Meaning | What to do |
|---|---|---|
| connected | Reins has an open connection | — |
| connecting… | Reins is connecting | — |
| not connected | Nothing tried yet, or the connection was closed after 5 minutes unused | **Connect**, or open its tools |
| needs sign-in | OAuth without valid tokens | **Sign in** |
| error | The last attempt failed; the reason is shown below the URL (for example "The server answered HTTP 401") | Fix the settings, then **Connect** |
| disabled | Switched off | Turn the switch on |

**Connect** connects afresh and lists the tools. Under each enabled server, **N tools** (or **Tools**) expands into its tools' names and descriptions; when the server says its tools changed, the list updates. The switch on the right enables or disables a server: a disabled server is not connected. **Remove** asks first, then forgets the server and its credentials.

## Servers

- **Brand New Box executor** (`https://executor.brandnewops.com/mcp?search_tools=true&elicitation_mode=browser`): OAuth, with dynamic registration. Leave **Advanced** empty.
- **Slack** (`https://mcp.slack.com/mcp`): OAuth with a client registered beforehand. Create a Slack app, add `<Reins URL>/oauth/mcp/callback` to its redirect URLs (Slack requires `https`), and give its client ID and secret under **Advanced**. Slack's server asks for every scope it supports unless you set **Scope** to the user scopes your app has.
