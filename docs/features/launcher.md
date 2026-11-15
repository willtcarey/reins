# Launcher

One list of things to open or do, from anywhere: sessions, the commands that apply where you are, and what extensions add.

## Usage

- **Open**: `Cmd+K` (Mac) / `Ctrl+K` (other), or the magnifying glass in the sidebar's header (on small screens, in the top bar next to the menu button)
- **Close**: `Escape`, click the backdrop, choose an item, or press `Cmd+K` again
- **Move**: the arrow keys move the selection (it wraps around); `Enter` runs the selected item
- **Search**: type to fuzzy-filter every item by its title and its second line

Choosing an item closes the Launcher and does what the item is for. If that fails, a message tells you why.

## The list

One flat list, with no sections. Each row has an icon, a title, a second line in grey (in a code font for a command or a path), and a dot for a status:

- 🟢 **Green pulsing dot**: running (a session at work)
- 🟠 **Amber dot**: something to look at (a session that finished with activity you have not read)

With no query, the items you ran last come first, latest first, for every kind of item. Going to a session in any other way (the sidebar, a link) counts too. Then come the commands, then each extension's items in its own order. With a query, the closest matches come first; between equal matches, those you ran last.

## Sessions

The sessions of open tasks, and each project's latest session of no task (a pinned one first). Sub-sessions (from delegate), archived sessions, sessions of closed tasks and sessions with no messages are left out.

- **Title**: the task's title; for a session of no task, its name, else its first message, else "Empty session" (as the sidebar shows it)
- **Second line**: the project, then the session's first message (left out when it is already the title)
- **Dot**: its activity, as the sidebar shows it

They come from the built-in *Sessions in the Launcher* extension: turn it off in Settings → Extensions to leave them out.

## Commands

Every command (the `/name` commands of the message box) is an item, with its `/name` as the second line, where it applies:

| Item | Command | Where |
|---|---|---|
| **New session** | `/new` | Everywhere: the new session page, in the project and task you are on |
| **Changes** | `/changes` | Beside a session: opens the Inspector's Changes tab, or brings it back |
| **Compact** | `/compact` | Beside a session: summarizes its conversation so far |
| **MCP servers** | `/mcp` | Beside a session: its MCP servers, in the Inspector |

The Launcher runs a command with no text after its name. A command that needs some says so in an error message: type it in the message box instead.

## From extensions

An extension's commands appear here by themselves, and an extension can add other items (one for each process that runs, for example): [building-extensions.md](building-extensions.md). The Launcher shows at once the items each extension gave the last time, and asks again each time it opens; the new items take their place when they come (within 1.5 s). An extension's items are first asked for soon after the page loads, so the first opening has them too.
