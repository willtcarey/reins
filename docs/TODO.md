# TODO

- [ ] *(2026-02-12)* Better conversation design
- [ ] *(2026-02-12)* Conversation naming
- [ ] *(2026-02-14)* Injected system prompt which talks more about the environment to bias the LLM towards file creation (may not actually need this)
- [ ] *(2026-02-14)* Comments on changes — allow users to comment on individual changes and inject those comments into the session context so the LLM can see and respond to feedback
- [ ] *(2026-02-17)* Support non-`origin` remotes in git operations (fetch, branch creation, diff base resolution) — currently hardcoded to `origin`
- [ ] *(2026-02-19)* Stash uncommitted changes on branch switch — when switching between task branches, uncommitted changes carry over and muddy the other branch's working tree. Stash before switching and pop after switching back. The diff view should treat stashed changes as "uncommitted" so they still appear in the UI.
- [ ] *(2026-02-19)* Project dashboard — a landing view for a project with pinned files, new session/new task buttons, and an overview of recent activity
- [ ] *(2026-02-19)* Task creation tool — expose a tool that lets the agent create a new task from within any conversation. Useful when a scratch session or an existing task surfaces work that should be tracked separately, so the user can say "create a task for this" without leaving the current context.
- [ ] *(2026-02-19)* Single-task lock and work queues — accept one active session at a time, deprioritise worktrees, build a queue primitive for sequential work items. See [planning doc](plans/task-queues.md).
- [ ] *(2026-02-19)* Worktrees/sandboxing code execution (deprioritised — see task queues planning doc)
- [ ] *(2026-02-20)* Pulling someone else's branch for local work — scratch sessions support this today but it's a loose fit. May need a dedicated workflow (e.g. associating an existing branch with a task) so the diff and sync controls work properly.
- [ ] *(2026-02-20)* Project assistant session — every project should have a long-lived "assistant" session: an ongoing conversation with the project that doesn't require opening a task or starting a new session. Always available for quick questions, brainstorming, or lightweight interactions.
- [ ] *(2026-02-21)* Task memory — give each session awareness of what has already happened within its task (e.g. prior sessions, changes made, decisions taken) so new sessions on the same task can pick up where previous ones left off without the user re-explaining context.
