# Shared addressed session messaging

Extract `SessionMessages.send(sessionId, message)` from orchestration so delivery is shared by the scoped scripting facade, parent reporter, and a future HTTP caller. Callers authorize targets; messaging owns reopening, native prompt/steer, activity and broadcast. No route, queue, retries or new persistence.

Move parent reporting to its own runtime event subscriber, registered after persistence. On the declared settlement boundary it awaits checkpoint flush then reads and delivers the outcome. Persistence neither calls nor awaits reporting. Detach all subscribers on close.

Validation: messaging delivery and broadcast tests; managed-session reporting integration; explicit persistence-before-reporting and detach test. Completed: 1,496 tests pass; typecheck, lint and diff checks pass. Scripting test callers now model already-open active sessions, avoiding background reopen work during fixture teardown.
