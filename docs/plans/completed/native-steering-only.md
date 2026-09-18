# Native steering-only session messaging

User-approved simplification: remove queued follow-ups entirely. No unsent-message table, dispatcher, active-turn restart, delivery mode, or adapter queue method.

## Interface

- `api.sessions.start(prompt, options)` creates a normal child/independent session and starts a prompt without waiting for its response; naming and parent semantics are unchanged.
- `api.sessions.send(sessionId, message)` resumes/starts an idle session or steers a busy session natively. Busy Claude rejects steering; Pi rejects when there is no active native loop (for example standalone compaction). No hidden wait, retry, queue fallback, or cancellation/restart.
- `api.sessions.wait(sessionId, timeoutMs?)` observes native idleness and retrieves the latest transcript/outcome. Preserve timeout and waiter-cancellation isolation. Keep the documented native Pi preflight limitation.

## Implementation/validation

Use red-green-refactor at scripting and adapter interfaces. Remove queue methods from the shared runtime contract, both adapters, prompt expansion, and test doubles. Keep existing runtime prompt completion/persistence behavior and historical transcripts. Update feature/runtime docs, run full tests, typecheck, lint and diff checks. No workspace/plugin work.

## Completed

Removed the queue mode and runtime queue methods. Scripting starts prompts asynchronously or delivers native steering; unavailable steering rejects without cancellation, deferred delivery, or extra prompts. Tests cover concurrent reopen with steering, idle resume, unsupported delivery, native compaction rejection, and existing wait/persistence behavior. Updated current documentation; earlier completed plans remain historical.

Validation: `bun test` (1,488 passing), `bun run typecheck`, `bun run lint` (zero warnings/errors), and `git diff --check` passed.
