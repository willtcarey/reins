# Error Handling

Error handling should make failures visible and preserve clear ownership. Do not add defensive code only to keep execution or rendering limping along when an invariant is broken.

## Default posture: throw and bubble

- Let unexpected errors bubble to the nearest real boundary.
- Prefer a clear thrown error over silent fallback values, swallowed exceptions, or broad `try`/`catch` blocks.
- Do not wrap platform APIs, runtime invariants, controller internals, or impossible states just because they could throw.
- Do not add compatibility/fallback paths unless the user explicitly asks for them.

A failure that breaks an assumption is useful signal. It should reach logs, the browser console, the router, the WebSocket/tool boundary, or whatever boundary owns surfacing that failure.

## Catch only when the boundary owns the outcome

Use `try`/`catch` when you are doing one of these:

- Translating a known error into a user- or protocol-level result, such as an HTTP status, form error, WebSocket command error, or tool result.
- Narrowing an external dependency failure into a domain-specific message.
- Running cleanup, usually with `finally`.
- Implementing an explicitly best-effort operation where partial failure is part of the contract.

If you catch an error, either handle it as part of the local contract or rethrow it. Avoid catch blocks that only log and continue.

## Layer boundaries

- **Backend models/services:** throw on failure. Callers decide how to present the error.
- **HTTP routes:** validate input and throw `HttpError` helpers for expected request errors. Let unexpected errors reach the router wrapper.
- **WebSocket commands and tools:** convert failures only at the command/tool boundary when the protocol expects an error message/result.
- **Frontend stores:** own REST/WS communication. They may expose expected loading/error state for feature contracts, but should not hide broken invariants.
- **Frontend components:** show local error UI for expected, recoverable interactions such as validation, failed mutations, or WS command failures. Let unexpected render/runtime failures reach browser/global error handling.

## Review checklist

Before adding error handling, ask:

1. Is this an expected outcome in the feature contract?
2. Is this the layer responsible for presenting the error?
3. Would catching this hide a broken assumption that we want to notice?
4. Should this simply throw and let an existing boundary handle it?
