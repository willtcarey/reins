# Extension use cases

Status: **ideas**, the first of them next. Each is an extension Reins should be able to support without host code for that one extension, and the host interfaces each would test. They came from the pinned plugin apps plan ([completed](completed/pinned-plugin-apps.md)), whose first case, a GitHub notifications inbox, is built as an added extension ([extension-loading.md](../dev/extension-loading.md), ADR-038). Build each against the SDKs (server-sdk.md, reins-sdk.md) and add to them only general capabilities that the case shows a need for.

Order: **Secrets** next; the others later.

## Secrets

A trusted Secrets plugin should be able to own encrypted secret storage and a client UI that collects values without placing them in conversation state. It should expose opaque secret references and agent-facing operations that can apply a stored value—for example, writing a named variable to an environment file—without returning the value to the model.

**Next.** What exists for it now: `reins.secrets` (host-owned storage, encrypted in the main database and scoped to each extension, ADR-033), agent tools (`reins.tools.register`) whose results the extension shapes, an HTTP API between its frontend and backend parts that does not pass through model messages (`reins.http.handle`, `http.call`), and a Settings page and views of its own. Not built: the interactive-request seam (a running tool that summons the extension's UI and waits for the user). Not yet checked: whether transport and telemetry log its HTTP and tool payloads.

This use case should validate:

- plugin-owned encrypted storage and key management
- frontend-to-plugin RPC that does not flow through model messages
- agent tool registration with redacted results
- plugin-controlled APIs for constrained secret operations
- an interactive-request seam if a running tool should be able to summon and wait for plugin-rendered user input
- transport and telemetry defaults that do not indiscriminately log RPC or tool payloads

The plugin owns secret-specific behavior; Reins should provide only the general contribution and communication interfaces needed to implement it. Strictly preventing an agent with arbitrary filesystem and shell access from later reading a secret written into its workspace is outside this plugin's guarantee.

## Gardener

A Gardener plugin should use a fast, free local model to keep finding small improvements across projects without the user prompting for them. The local model is not smart enough for open-ended work, so the plugin gives it narrow jobs that a machine can check and caps what reaches the user:

1. **Scout:** on a schedule, a read-only background agent walks a project and writes ranked findings (file, proposed change, how to verify it) to plugin storage. It produces findings, not code.
2. **Inbox:** the app shows a short digest of findings, capped at a few items, with a count in its sidebar section. Approving one creates a task and starts a session on a stronger model; ignored findings expire.
3. **Attempts (later):** for mechanical findings such as lint or type fixes, the local model tries best-of-N in an isolated checkout and keeps only an attempt that passes the project's check command.

A GitHub inbox is mostly UI, polling, and storage. The Gardener is the reverse: little UI, but heavy use of agent machinery. This use case should validate:

- scheduled, cancellable background services that run unattended: how their startup, retries, wakeups, idle behavior and shutdown are bounded
- plugin-started background sessions that stay out of session lists, with a chosen model and provider
- plugin-registered session kinds (ADR-019), such as a `gardener-scout` kind with read-only tools
- running check commands such as tests and lint on a node through process-run (ADR-018)
- per-project plugin settings: enabled projects, schedule, check command, and attempt budget
- promoting a finding to a task and starting its session

Attempts depend on a gap outside the plugin system: a task's sessions share the project's single checkout, so parallel attempts would collide, and an overnight run could switch branches under the user. Attempts need a worktree per attempt or strictly serialized runs. Scout-only operation never touches a checkout and can ship first.

## optmem assistant

An optmem plugin should provide a session kind for project assistant sessions whose context is managed by [optmem](https://x.com/victortaelin/status/2081453432318132603) rather than by the transcript and compaction alone. The goal is to preserve and manage what the assistant knows across many assistant sessions within a project, instead of each session starting cold and losing detail when it compacts.

Unlike an inbox or the Gardener, this plugin changes how a session itself runs rather than adding an app beside sessions. It may need no page at all, or only a small one for inspecting and pruning memory. This use case should validate:

- plugin-registered session kinds (ADR-019) that can stand in for the built-in assistant behavior, which today is derived from hierarchy inside the `agent` kind rather than being a kind of its own
- a seam for a kind to shape a session's context beyond its opening prompt and tools: what is retrieved into each turn, what is recorded after it, and how compaction interacts with plugin-managed memory
- plugin-owned storage for memory, scoped per project, that persists across sessions and plugin reloads
- choosing the kind when starting an assistant session, and possibly making it a project's default

The storage layer and the context seam are the open design work. ADR-019 kinds resolve once when the runtime opens, so per-turn memory retrieval and recording would need a new host interface or an agent tool the kind provides.

## Task artifacts

A task should be able to have artifacts: the things its work produces or is tracked in, such as a pull request today and a document being written (for example a Google Doc) later. Reins would provide the artifact primitive: a list on the task, visible in the task view and readable and writable by the task's agents. Plugins would provide new artifact types.

A minimal artifact may be only a titled URL. A plugin-provided type adds behavior around it: recognizing its URLs, showing live status (a PR's checks, review state and merge state), offering a custom renderer or summary card in the task view, and possibly actions (merge, open the review) or agent-facing operations. A GitHub plugin attaching the PR a task's branch opens would be the first case.

This use case should validate:

- a host-owned artifact primitive on tasks: storage, ordering, display and agent access
- plugin-registered artifact types with a host-defined renderer slot in the task view
- plugin-supplied status refreshed in the background, through plugin-owned storage and polling
- agents and plugins creating artifacts, for example when a task's branch is pushed and a PR is opened

Open: whether artifacts are typed, or all URLs with a plugin matching them to a renderer. Starting with untyped URLs and letting plugins claim them by pattern may be enough.
