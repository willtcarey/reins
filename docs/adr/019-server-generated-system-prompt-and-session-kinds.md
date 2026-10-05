# ADR-019: The Server Generates the System Prompt; Sessions Have Kinds

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The node built every session's system prompt (persona, guidelines, orchestration, task or project-assistant section, tool list, docs paths, context files, skills) and activated every tool it registered. The server could not choose a session's prompt or tools, so server features and extensions could not run a session as anything but a full Reins agent: an ad hoc background session that classifies, summarizes or generates a task would see the coding persona, every tool and the checkout's AGENTS.md. Prompt text also lived in node code, which only changes on a node restart (and, later, a node code update on remote machines).

## Decision

- **The prompt is split by who knows what.** The server renders the Reins part: the persona and guidelines, session orchestration (only when the session is offered `execute`) and the task or project-assistant section, chosen from the session's hierarchy as before. The node appends its environment: the list of the tools actually active, the REINS docs paths of its own install, and the checkout's context files and skills. Those are machine-local; the rest is product text, which now hot reloads on the server.
- **A session has a kind** (`sessions.kind`, default `"agent"`), and the prompt comes from the kind: there is no per-session prompt field. A kind is a server-side resolver from the session's rows to `{systemPrompt, tools?, environment, branch?}`. `agent` is the Reins prompt, every tool, the node's environment and its task's branch checked out. A utility kind has no side effects: a fixed prompt, no tools, no node environment and no checkout, so the model sees exactly its prompt and opening the session changes nothing on the node. "Assistant" and "task" stay derived from hierarchy inside `agent`, not kinds.
- **Kinds are validated in code**, not by a CHECK constraint, so adding one needs no migration. Server code creates sessions of a kind; scripts cannot.
- **Opening commands carry the resolved `runtime`**, read from the rows at send time like the lane seed. The node applies it when it opens the runtime: the prompt is the kind's plus (if asked) its environment, and the lane's active tools are the given list. The task snapshot shrinks to the `branch` the node checks out, which the kind also resolves (the agent's task branch; none for a utility kind), since the title and description now reach the node only inside the prompt.
- **Protocol version 6.** The opening command schemas are strict, so a node and server on either side of the change would refuse every prompt as invalid params (a terminal failure). Bumping the version makes them refuse each other's hello instead, and queued work waits in the outbox until both restart.

## Consequences

- A runtime already open keeps its prompt and tools until it is reopened (a move, a node restart, a stale runtime), as the task snapshot did before. Prompt edits reach a running conversation only then.
- The agent prompt's sections are in a new order: the tool list now follows the server's text (task section included) rather than preceding the guidelines. The text of each section is unchanged; fixtures on each side were cut from the old whole-prompt fixtures.
- Server features and later extensions add a kind as one registry entry and run it on a background session, with transcripts, waits and settlement like any session. Task generation was the first (`task-generator`): with it the server runs no Pi inference of its own, and a model call needs a connected node.
- The node no longer knows whether a session is a task or scratch session beyond the branch it checks out. The checkout on open is expected to go away; it is kept as is for agent sessions and not extended.
