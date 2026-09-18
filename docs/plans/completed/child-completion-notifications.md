# Child settlement reports

## Agreed simplification

Use the existing runtime settlement event, not the prompt completion promise. After persistence, send the child's latest outcome directly to its parent using existing session messaging: prompt when idle, native steer when busy. No waiting for parent idleness, inbox, database tables, receipts, dispatcher, retries, or per-parent chains. Busy Claude delivery is unsupported for now. Restart survival is not required.

## Implementation

The persistence observer accepts an optional `onSettled` callback, invoked after the runtime's declared completion event has passed through checkpoint processing. Session materialization wires this to `SessionOrchestration.send`, with a labelled structured outcome. Reopening alone does not report; later settlements report again. Startup failures without settlement are not reported. Callback errors are logged and not retried.

The earlier durable-notification implementation was removed. Core orchestration examples and non-polling guidance remain in the system prompt. Existing open runtimes need recreation to pick up the callback and revised prompt.

## Validation

Managed-session tests exercise no report on opening or inner Pi agent_end, idle-parent prompting, busy-parent steering, and subsequent settlement reports. Validation passed: 1,494 tests, typecheck, lint, and `git diff --check`.
