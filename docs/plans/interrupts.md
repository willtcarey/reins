# Interrupts

Status: **shaping** (2026-11-14). Nothing is decided beyond the direction below; the open questions are the work. Shape it in a dedicated session before any task.

## Why

Some work should not go on without an answer: an agent's call that needs the user's OK, an MCP server asking for input (elicitation), a repository's command waiting to be turned on (ADR-040), an extension's own question ("start a review session for PR #42?"). Today each feature does its own thing: Executor returns an approval URL that the agent repeats in the chat, Secrets opens a form in the Inspector and wakes the session later, repo MCP commands wait for a `/mcp` toggle. The user is moving toward not working in the chat, and toward answering such things elsewhere: a decision queue, possibly with a model resolving some of them.

## Direction

- **The host provides interrupts, not a decision queue.** Reins gains a primitive for "this waits on an answer", and hooks for raising, listing and resolving them. The decision queue, approval rules and any model-based resolver are **extensions** over those hooks. A Reins without them has no approvals.
- **A tool call can be interrupted and held**, and continue from its result once answered: the model makes the call once (not "declined, call again"). This is the one part only the host can do.
- **An interrupt need not be a tool call**: an extension can raise one for its own feature.
- **Resolvers can be extensions, including ones that use a model** to answer some interrupts automatically, leaving the rest to the user.

## The shape so far (to be shaped)

**An interrupt** is a question an extension raises and waits on:

- raised through the server SDK, e.g. `reins.interrupts.raise({ title, explanation, answerSchema, humanOnly?, about?, payload })`;
- `about`: what it concerns, optionally (a session, a task);
- an **answer schema** (approve/decline, or fields), so a generic UI can draw it and a model can answer it validly without knowing the raiser; or a view the extension registered, for answers a generic form must not handle (Secrets' masked values);
- stored by the host, listed to resolvers (`list`, `onRaised`), answered by the first `resolve`;
- its answer delivered back to the raiser: a promise for short-lived cases, and, for answers that may come hours later after reloads, a handler the extension registers per kind of interrupt (`reins.interrupts.handle(kind, …)`), called by the host as automations deliver after reloads;
- cancellable by its raiser, with an optional expiry.

**A tool-call interrupt** is an interrupt that also holds a call:

- raised before the call runs (an extension's **gate** on tool calls: bash patterns, MCP tools annotated `destructiveHint`) or during it (a tool itself, e.g. the MCP extension when a server elicits);
- while open: the call is held, its timeout paused, and its session shows as waiting; the session's other work stops (the agent is saying it needs the user to go on);
- once answered: the call runs (or returns that it was declined) and the run continues from its result; aborting the run cancels the interrupt.

## Cases to check the shape against

| Case | Raised by | Holds a tool call | Answer |
|---|---|---|---|
| Gate on risky calls (force push, `kubectl delete`, Stripe writes) | an approvals extension's gate | yes, before it runs | approve / decline |
| MCP native elicitation (form) | the MCP extension, during the call | yes | the server's schema |
| MCP URL elicitation | the MCP extension | yes, or ends the call and wakes later | opened / cancelled |
| Executor approvals (browser mode: `approvalUrl`, `resume`) | an Executor adapter | possibly (the call returns paused) | approved in Executor's page |
| Repo stdio command to turn on (ADR-040) | the MCP extension | no | turn on (human only) |
| Secrets request | the Secrets extension | no (returns at once today) | its masked form |
| An extension's own question (Spoke, automations) | that extension | no | its schema |
| An agent asking the user (the Queue idea) | a script API | possibly | choice / text |

## Open questions

1. **Human-only interrupts.** ADR-040 lets only the user, from the browser, turn on a repo command. With model resolvers, a raiser must be able to require a person, and the host must enforce it (a browser-only answer route, never `resolve` from an extension). Is this a flag on the interrupt, and is the browser check enough?
2. **With no resolver installed**, does an interrupt wait forever? Is there a minimal built-in way to answer (the open interrupt shown at its tool call or in the session's Inspector, with controls from its answer schema), with the queue extension as a better place rather than a requirement?
3. **Surviving a restart.** Holding a call in memory is simple; a restart then loses it (the call fails as lost). Durable tool-call interrupts need a run to continue from a transcript ending in a tool call without a result: check how Pi's harness continues such a transcript. In memory first, or durable from the start?
4. **Name.** "Interrupt" fits a held tool call; an extension's own question interrupts nothing. One name for both: interrupt, question, ask?
5. **One primitive or two layers?** Interrupts (raise, list, resolve, handle) and holding a tool call on one: is the second just an option of the first?
6. **Resolvers and ordering.** First answer wins; a model resolver that is unsure simply does not answer. Is that enough, or do resolvers need to claim, defer or escalate? Should the queue see interrupts that an auto-resolver may still answer?
7. **What the session and the user see** without any queue extension: Needs attention ("waiting for you"), the chat at the held call, the Inspector?
8. **Relation to existing features:** do Secrets, repo MCP commands and Executor approvals move onto interrupts, and in which order? Does an Executor adapter turn its `approvalUrl` + `resume` into a held call?
9. **Gates:** how an extension registers a gate on tool calls (which calls it sees, before Pi runs them, for scripts' `reins.*` calls as well as model tools), and how gates compose.
10. **Answers and secrets:** answers may hold sensitive values; where are they stored, for how long, and who can read them (a model resolver sees the interrupt's content)?

## Related

ADR-040 (repo MCP commands, browser-only allowing), docs/features/secrets.md (a request answered later, the session woken), docs/dev/mcp-servers.md, Executor's elicitation modes (`apps/docs/content/mcp.md` in `UsefulSoftwareCo/executor`: `automatic`, `model`, `native`, `browser`), MCP elicitation (form and URL modes, `-32042`, the experimental tasks with `input_required`), docs/plans/extension-use-cases.md, the TODO *Background processes on a session* (waking a session on an event).
