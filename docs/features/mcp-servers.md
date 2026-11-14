# MCP servers

Connect Reins to the services you use through their [MCP](https://modelcontextprotocol.io) servers: remote servers that Reins reaches by a URL, and local (stdio) servers that Reins runs as a command. Your agents can then read and act in those services in any session, in any project. A project can also define servers in its repository (*Servers from a project's `.mcp.json`*).

## Manage servers

You can manage servers in three ways:

- **In Settings**: go to **Settings → MCP**. There you can add a server and sign in to it. You can also see if agents can use it, and if not, why. To see its tools, expand **Tools**. To check a server again, for example after it failed, use **Test**. To edit, turn off, sign out of or remove a server, use its controls.
- **In a session**: type `/mcp` to see the servers that the session can use, yours and its project's, and turn them on or off (*A session's MCP servers*).
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

## Servers from a project's `.mcp.json`

A project can define MCP servers in a `.mcp.json` file at the root of its repository, in the same `mcpServers` shape that Claude Code and Cursor use. Thus the team shares the definitions, and each person signs in on their own. For example:

```json
{
  "mcpServers": {
    "stripe": { "type": "http", "url": "https://mcp.stripe.com" },
    "shopify-dev": { "command": "npx", "args": ["-y", "@shopify/dev-mcp@latest"] }
  }
}
```

- **Which file**: Reins reads the `.mcp.json` of the session's own checkout, each time the session starts to run (not while it runs). Thus a session on a branch uses that branch's file. If you change the file, the session uses the change the next time it starts.
- **Only that project**: these servers are available only to the sessions of that project. If a server in the file has the same name as one of your own servers in Settings, Reins skips the file's server and uses yours: a repository cannot stand in for a server that you trust by its name. The session's MCP servers list shows the skipped entry and why.
- **Remote (HTTP) entries** have a `url`, and `"type": "http"` or `"sse"`. They run no code on your machines, so they are on until you turn them off. If the server asks for a sign-in, sign in from the session's MCP servers list (`/mcp`). Your sign-in is kept encrypted, for that project and server name. If the file changes the server's URL or headers, you are signed out of it. Header values can use `${VAR}` and `${VAR:-default}`. Reins takes the value only from what you give in the session's MCP servers list (or the default), never from its own environment, so that a file cannot send Reins' secrets to its server.
- **Command (stdio) entries** have a `command`, and can have `args`, `env` and `cwd`. Each session runs its own process, on its node, in its checkout (a `cwd` is a directory inside the checkout). Values in `env` can use `${VAR}`: Reins takes the value from the node's environment, or from a value that you give in the session's MCP servers list.
- **Entries that Reins cannot use** are skipped, and the session's MCP servers list shows why: for example a name with capital letters or `_` (a name must be lowercase letters, digits and hyphens), or an unknown `type`.

### Which servers may run

Each server in a `.mcp.json` has a toggle in the session's MCP servers list (type `/mcp`; *A session's MCP servers*): on, the server may run; off, it does not run in any session of the project.

- **HTTP servers** are on until you turn them off.
- **Command (stdio) servers** are off until you turn them on, because a command from a repository could do anything that your user can do. Reins does not start a server that is off and does not list its tools. Nothing opens by itself: type `/mcp` to turn the server on.
- **Turning a command on** allows that exact command, for the project: the command line and the names (not the values) of its environment variables, as that session's checkout has them. The agent can use the server the next time it looks for tools. What you allow is the command line, not the code that it loads: if the command downloads a package (for example `npx -y …@latest`) or runs a file from the repository, a change to that code does not ask again.
- **A changed command is off.** If the file changes the command, the server shows "its command changed" and is off until you turn it on again. The commands that you allowed before stay allowed. For example, if a branch changes the arguments and you turn that on too, sessions on `main` and on the branch both run, and switching between them asks nothing.
- **Turning a server off** stops it in every session of the project. When you turn it on again, the commands that you allowed before need nothing more.

**What agents know of servers that are off.** Off means the same thing for every server, whatever the reason: a command not allowed yet, a command that changed, a server you turned off, or one of your own servers disabled in Settings. The agent's instructions name the servers that are off, and say that you turn them on with `/mcp`. The agent cannot use them or search their tools. It can tell you that one would help.

**Only you can turn a command on, from Reins in your browser.** Agents can edit `.mcp.json`, so no agent, script, tool or extension can allow a command.

## A session's MCP servers

Type `/mcp` in a session to see the servers that it can use, in the Inspector. The list is for the session's checkout: it stays open while you move between sessions on that checkout, and closes when you go to another. Its controls act at once. It has two sections:

- **The project** (headed with its name): the servers of the session's `.mcp.json`. Their toggles act for every session of the project. If there are none, the section says why: there is no `.mcp.json` in the checkout, the file cannot be used (and why), or the session has not read it yet. A session of no project does not have this section.
- **Global**: your own servers, each as Settings shows it: its status, its toggle (which acts for every session), **Sign in** or **Sign out**, and its **Tools**. To add, edit or remove one, choose **Edit in Settings**.

For each server of the `.mcp.json`, the list shows:

- its name and badges, its address or command, and its status: ready, needs sign-in, off, or an error with the last lines that the command wrote to its error output;
- its toggle, **Sign in** or **Sign out** for an HTTP server, and its **Tools** (for a command, the list starts it in that session);
- the values of its `${VAR}`s that you give (kept encrypted, and not shown again).

The list also shows the entries that Reins skipped, and why. Commands that you turned on stay allowed: there is no list of them to remove from. To stop a server, turn it off.

## Sign-in and advanced settings

Some services accept a sign-in only when Reins is opened over `https`, or only with an app that you registered with the service first. For such a service, give the app's client ID and secret under **Advanced**. Register `<Reins URL>/extensions/mcp/oauth/callback` as the app's redirect URL. For an older server that supports only the legacy HTTP+SSE transport, set **Transport** under **Advanced**.

## How agents use the tools

MCP tools are not given to the model as its own tools. Agents call them from `execute` scripts, through Reins code mode (`reins.tools`, [scripting.md](scripting.md)). Each session tells the agent which servers are turned on and gives your note for each. The agent then finds the tools it needs (all servers at once, or one server) and calls them. A tool's ID is `mcp`, the server's name and the tool's name, with two underscores between them, for example `mcp__vercel__list_deployments`.

Thus a server with many tools does not fill the agent's context. The agent can also use code to combine and filter the results before it reads them.
