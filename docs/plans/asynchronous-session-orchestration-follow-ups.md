# Asynchronous session orchestration follow-ups

- [ ] Design the UI for sessions delegated by an assistant, including how they appear and how users navigate their parent/child relationship.
- [x] Design cross-session notifications between parent and child sessions (and between children), including how those notifications render in the conversation view.
- [x] Show running child sessions inside the parent conversation with a subtle, non-thinking activity indicator that links directly to the child session.
- [ ] Design conversation rendering for `execute` calls that start sessions or send follow-ups, so these orchestration actions are clear without exposing distracting implementation detail.
