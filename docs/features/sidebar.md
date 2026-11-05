# Sidebar

The sidebar is on the left of the workspace (on a phone, the first page). Its header has **Search sessions** (Cmd+K), **Settings** and, on a desktop, **Hide sidebar**. A hidden sidebar is a narrow rail with the same buttons and a dot on its expand button: green while any session runs, amber while any session has something you have not opened yet. Reins computes the dot from every session, whatever sections are shown.

Below the header is a stack of **sections**. Reins has two, and extensions can add more:

1. **Recent** (the Recent sessions extension): the 8 sessions with the latest activity (a run that ended, a rename), from any project (or none), the latest first. Opening a session does not move it, so you can switch between rows and the list stays in place. When you close a task, its sessions leave Recent: a closed task is work you are done with. A session of a closed task comes back when a new run starts in it after the task closed (for example, you send it a message), and all of them come back if you reopen the task. A session that closes its own task does not come back when its run ends. When a session's activity moves it, its row slides to its new place. Each row shows the session's name (or its first message), its project and its task, and a dot (green: running; amber: new). Click a row to open the session. It also shows sessions that Projects shows: it is a shortcut, not a filter.
2. **Projects**: every project, with its assistant's conversations and its tasks ([projects.md](projects.md) *Sidebar*).

Each row's menu (right-click, or long-press on a phone) has **Copy session ID**, **Mark as read** or **Mark as unread** (not while the session runs), **Rename** and **Archive**. In Projects, the menu also has Pin or Unpin, and Move. Recent has no Pin, because pinning puts a session first in its project's list, and Recent does not use that order.

## Projects

- **Projects are in name order.**
- **Only the current project is expanded.** The current project is the project of the session (or new session page) you look at. When you open a session in another project, that project expands and the previous one collapses. A project that you expanded by hand stays expanded until you collapse it. If you collapse the current project, it stays collapsed until you go to another project. Settings and other pages that have no project change nothing. After a reload, only the current project is expanded.
- The project's menu also has **History**, **Edit** and **Remove**. Below the projects are **Other sessions** (sessions of no project, when there are any) and **+ Add Project**.

## Height

Each section is as tall as its content. The sidebar has one scroll area below its header: when the sections are taller than the window, scroll the sidebar. Opening a session never scrolls the sidebar, so you can switch between rows in Recent without the list moving.

## Settings → Sidebar

**Settings → Sidebar** lists every section in the order that the sidebar shows them. Each has **up** and **down** buttons to move it, and a switch to show or hide it. Changes show in the sidebar immediately, and Reins keeps them on the server (the `sidebar_sections` setting), so they are the same on every browser. If Reins cannot save a change, it undoes the change and shows an error.

The default order is Recent, Projects, then the sections of other extensions in the order they registered. A section that you have not ordered yet (for example, a new extension's) is shown at the end, switched on. A section that is not registered now (its extension was removed) keeps its place in your order, if it comes back.
