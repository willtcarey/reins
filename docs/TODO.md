# TODO

Roadmap and open items. Remove items when they're done — don't check them off.

- *(2026-02-12)* Better conversation design — [inspiration](https://x.com/benjitaylor/status/2027902450049708385)
- *(2026-02-12)* Conversation naming — auto-generate a short name/topic for each session. Replaces the current first-message display with a proper name field. May unify `SessionRow` and session list item types since the name would be available directly on the session.
- *(2026-02-14)* Comments on changes — allow users to comment on individual changes and inject those comments into the session context so the LLM can see and respond to feedback
- *(2026-02-17)* Support non-`origin` remotes in git operations (fetch, branch creation, diff base resolution) — currently hardcoded to `origin`
- *(2026-02-19)* Stash uncommitted changes on branch switch — when switching between task branches, uncommitted changes carry over and muddy the other branch's working tree. Stash before switching and pop after switching back. The diff view should treat stashed changes as "uncommitted" so they still appear in the UI.
- *(2026-02-19)* Project dashboard — a landing view for a project with pinned files, new session/new task buttons, and an overview of recent activity
- *(2026-02-19)* Single-task lock and work queues — accept one active session at a time, deprioritise worktrees, build a queue primitive for sequential work items. See [planning doc](plans/task-queues.md).
- *(2026-02-19)* Worktrees/sandboxing code execution (deprioritised — see task queues planning doc)
- *(2026-02-21)* Task-pinned documents — let sessions mark repo files (plans, state-tracking docs, decision logs, etc.) as important for the current task. New sessions on the same task automatically ingest those documents, so context carries forward through the repo itself rather than through a separate memory store.
- *(2026-02-22)* "View full file" link in tool results — add a link on Read tool results that opens the full file content via the existing `/file` HTTP route, so users can see the complete file without it being sent twice over the WebSocket.
- *(2026-02-25)* Persist activity state across refresh — session activity indicators (running/finished dots) are lost on page refresh because they're purely in-memory on the client. Include `isStreaming` in session list endpoints so the frontend can seed activity state on load/reconnect.
- *(2026-03-03)* Docker DB persistence — the SQLite database is written to `.reins/` inside the container's working directory, which is lost on restart. Need a volume mount or configurable DB path so data survives container restarts.
- *(2026-03-03)* Keyboard shortcuts — switch between Chat/Changes tabs, create a new session, create a new task, navigate between sessions, and other common actions without reaching for the mouse.
- *(2026-03-15)* Smarter assistant compaction — explore techniques from losslesscontext.ai and related research for better context preservation during compaction. Current compaction loses important context; investigate structured summaries, hierarchical compaction, or other approaches.
- *(2026-03-21)* Delegate tool call expansion while running — the delegate tool call inline rendering doesn't support expanding to see live output while the sub-session is still in progress. Need to allow expansion/streaming of delegate results before the call completes.
- *(2026-03-21)* Delegate sub-session badge — show a "+N" badge on sessions that have spawned delegate sub-sessions. The badge should be clickable to reveal the list of sub-sessions.
- *(2026-03-21)* Missing user message on mid-turn refresh — refreshing the page while an agent turn is in progress can cause the preceding user message to disappear. Likely a regression from the message display refactor.
- *(2026-03-27)* Green activity dot (running) not showing on sessions — amber (finished) dot works fine but the green pulsing dot doesn't appear for running sessions. Broke around the delegate sub-session badge refactor. Code paths look correct on paper — needs browser debugging with console.log in `_setRunning` to trace whether `agent_start` events are arriving and whether the dot renders but gets immediately cleared.
