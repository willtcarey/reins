# MCP servers

Connect Reins to the services you use through their [MCP](https://modelcontextprotocol.io) servers: remote servers that Reins reaches by a URL, and local (stdio) servers that Reins runs as a command. Your agents can then read and act in those services in any session, in any project.

## Manage servers

You can manage servers in two ways:

- **In Settings**: go to **Settings → MCP**. There you can add a server and sign in to it. You can also see if agents can use it, and if not, why. To see its tools, expand **Tools**. To check a server again, for example after it failed, use **Test**. To edit, turn off, sign out of or remove a server, use its controls.
- **By asking an agent**: tell the agent which service to connect. It adds the server for you. When the server needs a sign-in, the agent gives you the page to open.

For each server, write a short note for agents: what the service is for and when to use it. Every session gets this note.

Remote servers can use the service's own login (OAuth), a fixed header with an API key or token, or no sign-in. Reins keeps you signed in. Credentials are stored encrypted on your Reins server and are not shown again after you save them.

## Add a local (stdio) server

Some MCP servers are programs that you run, for example `npx -y @modelcontextprotocol/server-everything`. To add one, select **Add MCP server**, then **Command (stdio)**, and give:

- **Command**: the program, for example `npx`, `uvx` or a full path.
- **Arguments**: one on each line.
- **Environment**: variables the server needs, such as an API token. Values are stored encrypted on your Reins server and are not shown again. To keep a saved value when you edit the server, leave its field blank.
- **Working directory**: where it starts. If you leave it blank, it starts in the session's checkout. A relative directory, for example `web`, is inside the checkout.

These fields are the same as the `mcpServers` entries in Claude's and Cursor's configuration files (`command`, `args`, `env`, `cwd`), so you can copy an entry from there. An agent can also add one for you with the same fields.

**Each session that uses a local server starts its own process**, on the session's node and in the session's checkout, as Claude Code and Cursor do. Thus a server that works on files, such as a git or language server, works on that session's files. The command must be installed on the nodes where your sessions run. Reins starts a session's process when the session first uses the server, and stops it after 5 minutes without use. A local server needs a session: other extensions cannot call its tools.

In Settings, a local server shows its status. "Ready" means that agents can use it, not that a process is running now. If a start fails or a process stops with an error, the status shows the last lines that the program wrote to its error output (for example, "Program not found"). Settings cannot test a local server, because it has no session: ask an agent to test it. When you change its command, arguments, environment or directory, or turn it off, Reins stops all its processes. The next use in each session starts a new one. When Reins restarts, it also stops them.

Agents can find a local server's tools also while no process runs: Reins keeps the list of tools from its last start, in any session. The first search after you add or change the server starts it in that session.

Servers that a project defines in its repository (`.mcp.json`) are not supported yet.

## Sign-in and advanced settings

Some services accept a sign-in only when Reins is opened over `https`, or only with an app that you registered with the service first. For such a service, give the app's client ID and secret under **Advanced**. Register `<Reins URL>/extensions/mcp/oauth/callback` as the app's redirect URL. For an older server that supports only the legacy HTTP+SSE transport, set **Transport** under **Advanced**.

## How agents use the tools

MCP tools are not given to the model as its own tools. Agents call them from `execute` scripts, through Reins code mode (`reins.tools`, [scripting.md](scripting.md)). Each session tells the agent which servers are turned on and gives your note for each. The agent then finds the tools it needs (all servers at once, or one server) and calls them. A tool's ID is `mcp`, the server's name and the tool's name, with two underscores between them, for example `mcp__vercel__list_deployments`.

Thus a server with many tools does not fill the agent's context. The agent can also use code to combine and filter the results before it reads them.
