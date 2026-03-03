# TODO

- [ ] *(2026-02-12)* Better conversation design — [inspiration](https://x.com/benjitaylor/status/2027902450049708385)
- [ ] *(2026-02-12)* Conversation naming
- [ ] *(2026-02-14)* Injected system prompt which talks more about the environment to bias the LLM towards file creation (may not actually need this)
- [ ] *(2026-02-14)* Comments on changes — allow users to comment on individual changes and inject those comments into the session context so the LLM can see and respond to feedback
- [ ] *(2026-02-17)* Support non-`origin` remotes in git operations (fetch, branch creation, diff base resolution) — currently hardcoded to `origin`
- [ ] *(2026-02-19)* Stash uncommitted changes on branch switch — when switching between task branches, uncommitted changes carry over and muddy the other branch's working tree. Stash before switching and pop after switching back. The diff view should treat stashed changes as "uncommitted" so they still appear in the UI.
- [ ] *(2026-02-19)* Project dashboard — a landing view for a project with pinned files, new session/new task buttons, and an overview of recent activity
- [ ] *(2026-02-19)* Single-task lock and work queues — accept one active session at a time, deprioritise worktrees, build a queue primitive for sequential work items. See [planning doc](plans/task-queues.md).
- [ ] *(2026-02-19)* Worktrees/sandboxing code execution (deprioritised — see task queues planning doc)
- [ ] *(2026-02-20)* Pulling someone else's branch for local work — scratch sessions support this today but it's a loose fit. May need a dedicated workflow (e.g. associating an existing branch with a task) so the diff and sync controls work properly.
- [ ] *(2026-02-20)* Project assistant session — every project should have a long-lived "assistant" session: an ongoing conversation with the project that doesn't require opening a task or starting a new session. Always available for quick questions, brainstorming, or lightweight interactions.
- [ ] *(2026-02-21)* Task-pinned documents — let sessions mark repo files (plans, state-tracking docs, decision logs, etc.) as important for the current task. New sessions on the same task automatically ingest those documents, so context carries forward through the repo itself rather than through a separate memory store.
- [ ] *(2026-02-21)* Surface coding agent errors to the frontend — errors from the coding agent arrive over the WebSocket but are not displayed in the UI. Show them so the user knows when something goes wrong.
- [ ] *(2026-02-22)* Syntax-highlighted file previews in tool results — when a Read tool result contains file text, render a truncated preview with syntax highlighting based on the file extension instead of a plain `<pre>` block.
- [ ] *(2026-02-22)* "View full file" link in tool results — add a link on Read tool results that opens the full file content via the existing `/file` HTTP route, so users can see the complete file without it being sent twice over the WebSocket.
- [ ] *(2026-02-25)* Persist activity state across refresh — session activity indicators (running/finished dots) are lost on page refresh because they're purely in-memory on the client. Include `isStreaming` in session list endpoints so the frontend can seed activity state on load/reconnect.
- [ ] *(2026-03-03)* Keyboard shortcuts — switch between Chat/Changes tabs, create a new session, create a new task, navigate between sessions, and other common actions without reaching for the mouse.
- [ ] *(2026-03-01)* Diff view broken when a file is added and removed in the same diffset — if a file is both created and deleted within the changes being diffed, the diff view doesn't handle it correctly.
