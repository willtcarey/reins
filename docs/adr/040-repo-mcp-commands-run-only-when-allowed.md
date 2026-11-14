# ADR-040: A repository's stdio MCP commands run only when the user turned that exact command on, from the browser

- **Status:** Accepted
- **Date:** 2026-11-13
- **Author:** Will (with Claude)

## Context

A project's `.mcp.json` (the `mcpServers` shape of Claude Code and Cursor) can define stdio servers: commands that Reins would run on the session's node, in its checkout. The file is in the repository, so whoever can change the repository can change the command: a teammate, a dependency's postinstall, a branch from a pull request, or an agent. Agents edit files in the checkout all the time, and an agent can be steered by what it reads (a prompt injection in an issue, a web page, a file). If an agent could turn a server on, an injected agent could write a command into `.mcp.json` and allow its own edit.

The same project is often open on several branches at once (worktrees, sessions on different tasks), and a branch may change an entry (a new argument, a pinned version) while `main` keeps the old one. Switching between them must not ask each time.

## Decision

**What turning a stdio server on allows is its exact command**: the hash of its command, args, cwd and env names (`versionHash` of `stdioVersion`, `repo-config.ts`). Env values are not in it: they hold `${VAR}` references to each person's own secrets, which differ between people and machines.

**A project has a set of allowed commands per server name, keyed by the command, not by branch.** A stdio entry runs when its switch is on and the exact command its session read is in the set. Turning it on adds to the set, so `main`'s command and a branch's both run once each is turned on, and switching back and forth asks nothing. Each session runs the command its own checkout read when its runtime opened. Commands are never taken out and do not expire: turning the server off stops every command of it. (A project modal section listing the allowed commands with **Remove** was built first and dropped: the session's list is where servers are seen, and off is the control that stops one.)

**Nothing runs before**: no process, and no tool listing (not even a kept list from another command). The agent sees the server as off: its system prompt lists it with every other server that is off (the user's own disabled ones too), with where the user turns each on, and a call fails saying so. Search leaves it out. Off has one meaning for agents, whatever made it off, and the agent decides whether to tell the user.

**The user answers with a toggle per server**, in the session's list of its `.mcp.json`'s servers (the Inspector, opened with `/mcp`). On allows the command as that session's checkout has it; a command the file changed since shows off. Off stops the server, HTTP or stdio, for the project, and keeps the allowed commands, so on again needs nothing more. HTTP servers are on until turned off: they run no local code. Nothing waits for the user: nothing is recorded, the list does not open by itself and no session is told of a toggle; asking the user belongs to a later decision queue.

**One module decides whether a repo server may run** (`repo-gate.ts`): `McpRepoGate.block(row, sessionId)`, which connections, a stdio server's kept tool list, the prompt section, tool search and the session's list all ask, so the list and agents cannot disagree. A repo server that may not run is `off` whatever the reason (its switch, or a command not allowed); `disabled` is the user's own servers' (Settings). The message agents are told is the gate's; connections pass it on and know nothing of `.mcp.json`.

**Only the user, from the browser, can turn a server on.** The set is written by one object, `McpRepoSwitch` (the toggle), which only the extension's HTTP routes hold. The routes give it only requests a browser made (`HttpCall.browser`: `Sec-Fetch-Site: same-origin`, or over plain HTTP, where browsers send no Fetch Metadata, an `Origin` that is Reins' own; a browser sets these and a page's script cannot). `reins.mcp`, the tool provider, the prompt section and everything another extension can reach hold `McpRepoGate`, which only answers. So no script, tool, `reins.mcp` method or extension API can allow a command; tests try each path (`repo-servers.test.ts`, *no agent path can turn a server on*), and the guarantee breaks visibly if a future method is added to scripting with a name about allowing.

**The set is kept in the host's secret storage** (`reins.secrets`, `allowed/<project>/<name>/<hash>`), encrypted and authenticated with the server's key: a row written into the extension's database file allows nothing.

## Options considered

- **Allow by name** (any command under a name once on). Rejected: the point is that a change to the command needs turning on again.
- **One allowed command per name** (the latest replaces the one before). Rejected: two branches with different commands would ask at every switch.
- **Allow per branch.** Rejected: branches are renamed, rebased and deleted, and the same command on two branches would ask twice; the content is what is trusted.
- **Hash the env values too.** Rejected (the user's decision): values carry each person's secrets through `${VAR}`. The cost: a change to a value does not ask again, also for a variable whose value can load other code (`NODE_OPTIONS`, `LD_PRELOAD`).
- **Allowing through `reins.mcp` or a tool, with the user confirming in chat.** Rejected: an agent can claim the user agreed.
- **A form per command, with Approve and Reject** (built first). Replaced by the list: one place per session for every server, the same control to allow and to stop, and no per-session rejection to keep. The toggle stays per exact command: a toggle by name would let anyone who changes the file run any command once the name is on.
- **Recording that a session waits, opening the list by itself and telling sessions of a toggle** (built, then removed): the agent goes on without the server, and the user turns it on when they want it.
- **A placeholder tool for a server that is off** (`mcp__<server>__turned_off`, first in every search; built, then removed): it was a tool that was not one, and it made a command not allowed look different to agents from a server turned off, which was hidden. The prompt's list of servers that are off names them all the same way.
- **An agent opening the list** (`reins.mcp.showServers()`). Not done for now: the agent names `/mcp`, and the user opens it.
- **The switch and the allowed set as two statuses** (`disabled` and `off`, built first, with the check in the stdio layer and again in the list). Replaced by the gate: the user sees one toggle, so there is one state and one place that decides it.
- **Expiring allowed commands.** Not done: turning the server off stops it.
- **Blocking commands that fetch code that can change** (`npx -y …@latest`, unpinned `uvx`, unpinned images). Rejected: they are the common case.
- **Warnings by kind of command** (unpinned `npx`/`uvx` packages, images without a digest, repository scripts, code-loading variables). Tried, then removed: the list of runners and their pinning rules needs constant upkeep, and a warning that misses a case reads as an all-clear.

## Consequences

- Reins does not authenticate its browsers. A process that can reach Reins' HTTP API and forges a browser's `Sec-Fetch-Site` or `Origin` header (a deliberate `curl` from an agent's shell on a node that can reach the server) is not told apart. The check stops scripts and commands that do not pose as a browser, and agents are never pointed at the route; closing the gap needs browser authentication (a session cookie the nodes do not hold).
- Global stdio servers (Settings → MCP, or `reins.mcp.add`) are not gated this way: the user, or an agent the user asked, adds them by hand, and an agent with a shell can run commands anyway. The gate guards against the repository, not against the agent's own tools.
- A command that runs a repository file (`node scripts/mcp.js`) or a package's latest release runs whatever that is at each start: what is allowed is the command line, not the code it loads.
