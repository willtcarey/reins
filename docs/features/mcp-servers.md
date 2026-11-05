# MCP servers

Connect Reins to the services you use through their remote [MCP](https://modelcontextprotocol.io) servers. Your agents can then read and act in those services in any session, in any project.

## Manage servers

You can manage servers in two ways:

- **In Settings**: go to **Settings → MCP**. There you can add a server and sign in to it. You can also see if agents can use it, and if not, why. To see its tools, expand **Tools**. To check a server again, for example after it failed, use **Test**. To edit, turn off, sign out of or remove a server, use its controls.
- **By asking an agent**: tell the agent which service to connect. It adds the server for you. When the server needs a sign-in, the agent gives you the page to open.

For each server, write a short note for agents: what the service is for and when to use it. Every session gets this note.

Servers can use the service's own login (OAuth), a fixed header with an API key or token, or no sign-in. Reins keeps you signed in. Credentials are stored encrypted on your Reins server and are not shown again after you save them.

Some services accept a sign-in only when Reins is opened over `https`, or only with an app that you registered with the service first. For such a service, give the app's client ID and secret under **Advanced**. Register `<Reins URL>/extensions/mcp/oauth/callback` as the app's redirect URL. For an older server that supports only the legacy HTTP+SSE transport, set **Transport** under **Advanced**.

## How agents use the tools

MCP tools are not given to the model as its own tools. Agents call them from `execute` scripts, through Reins code mode (`reins.tools`, [scripting.md](scripting.md)). Each session tells the agent which servers are turned on and gives your note for each. The agent then finds the tools it needs (all servers at once, or one server) and calls them. A tool's ID is `mcp`, the server's name and the tool's name, with two underscores between them, for example `mcp__vercel__list_deployments`.

Thus a server with many tools does not fill the agent's context. The agent can also use code to combine and filter the results before it reads them.
