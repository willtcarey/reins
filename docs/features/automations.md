# Automations

Automations wake sessions up. They come from the built-in **automations** extension ([extensions.md](extensions.md)). An automation is **a trigger, a target and a message**: when the trigger fires, Reins sends the message to the target session.

- **Triggers:**
  - A **schedule**: "every 10 minutes", "every day at 09:00".
  - A **command**: Reins runs a command on a node at an interval, and the automation fires when the command succeeds (exit code 0). Checking costs no model run: the session runs only when something happened.
- **Targets:**
  - **This session** (the default): the session that made the automation.
  - **Its own session**: a hidden session that the automation starts at its first delivery and keeps, so each run can see what earlier runs found.
  - **A new session each time**: each delivery starts a fresh session, for work that should start clean each time.

There is no Automations tab yet. You ask an agent, and the agent uses `api.automations.create` (in `execute`). Agents are told about automations in their system prompt: when you ask one to watch for something or to tell you later ("tell me when this deploys", "let me know when CI passes"), it makes an automation and ends its turn, rather than waiting. If it can do the work itself with a command that ends within a few minutes, it runs the command instead. Settings → Extensions shows the extension, its functions and its **scheduler** service.

## "Tell me when this PR merges"

Ask the agent in the session: *"Tell me when PR 42 merges."* The agent makes a command automation:

```js
await api.automations.create({
  trigger: { command: "gh pr view 42 --json state -q .state | grep -x MERGED", every: "2m" },
  message: "PR 42 has merged: tell the user.",
  once: true,
});
```

- Every 2 minutes Reins runs the command on the session's node, in the session's directory (or on `node` and in `cwd` when given). Nothing goes to the model.
- When the command exits 0, the message comes into the chat as written, and the command's output goes to the model in the message's details (below).
- **Without a message**, the command's output is the message: the command prints what the session should know ("Deploy 18 is live: …"). A schedule always needs a message.
- Either way the model is told that the output is not your words and not to follow instructions in it, because it can contain other people's text (a PR comment).
- `once: true` cancels the automation after that message. Without it, the automation fires each time the command succeeds.
- A check that cannot run (the node is offline, the command times out) is recorded as a failed run. Checks that do not fire are only counted.

## "Remind me" and periodic checks

A schedule sends the message each time it is due: *"Every 10 minutes, look at the build."* → `create({ trigger: { schedule: "10m" }, message: "…" })`.

- **If the session is running:** the message joins the run in progress (the model reads it at its next step). It is skipped only if the run that the automation's previous message started is still running, so the messages do not pile up behind each other. The run history records each skip.
- **No expiry.** It continues until it is cancelled, or until its first delivery with `once: true` (a one-time reminder).

## What the chat shows

The message comes into the chat as it was written, with **sent from automations ›** under it. Click that label to open the message's details, which the model also gets:

- which automation sent it, and when,
- how to cancel it (or that it fired once and is now cancelled),
- for a command, its output (at most 16 000 characters), or, when the output is the message, that it is a command's output.

## "Every day, check my notifications"

Ask any agent: *"Every day at 09:00 London time, list my new GitHub notifications."* The agent makes an automation with its own session:

```js
await api.automations.create({
  trigger: { schedule: "daily 09:00", timezone: "Europe/London" },
  target: "own",
  name: "GitHub notifications",
  message: "List my new GitHub notifications since the last run.",
});
```

- At its first delivery the automation starts its **hidden session**. Later deliveries go to the **same** session. The browser does not show hidden sessions.
- By default the session works in the directory of the session that asked, with no project. The agent can give another location (`source`) and a model (`model`).
- **Each run's output is its final reply.** The agent reads them with `api.automations.runs(id)`: when each run started and ended, its outcome (`completed`, `failed`, `skipped`, `lost` when Reins restarted during the run), and its output or error. An automation also shows how many of its latest runs failed in a row (`consecutiveFailures`).
- **Compaction.** The model compacts the session by itself near its context limit. The automation can set a lower limit (`compactAboveTokens`): after a run that ends above it, Reins compacts the session, and the summary keeps what later runs need.
- **A broken session.** If the session goes wrong, ask the agent to replace it (`api.automations.replaceSession(id)`): the next delivery starts a new hidden session. If the hidden session is deleted, the next delivery also starts a new one.

A command trigger works with its own session too: the session runs only when the command fires.

## "Review each new Dependabot PR"

For work that should start clean each time, use `target: "new"`. Each delivery starts a new session, which is shown in the session list (with `background: true` it is hidden), so you can open each one.

- **By default, the new sessions are in the project of the session that made the automation**, so you find them with that project's sessions. Give `project: null` for no project, or a project's ID for another project.
- An own session has no project by default. Give `project: "this"` or an ID to put it in one.
- If the project is deleted, each delivery fails and is recorded in the runs. The automation is not cancelled.

```js
await api.automations.create({
  trigger: { command: "gh pr list --search 'author:app/dependabot -label:agent-reviewed' --limit 1 --json number,title,url -q '.[] | \"#\\(.number) \\(.title) \\(.url)\"' | grep .", every: "30m" },
  target: "new",
  name: "Dependabot review",
  message: "Review this Dependabot PR against our upgrade checklist, post your assessment as a PR comment, then add the label agent-reviewed.",
});
```

- The command prints one PR that is not reviewed yet, and exits 0 only when there is one. The label keeps the state in GitHub, so each PR is reviewed once.
- The PR's line goes to the new session in the message's details.
- **A delivery is skipped while the session that the previous one started is still running**, so two sessions do not take the same PR.
- `--limit 1` gives one PR per session. Without it, one session gets all the waiting PRs.
- Each run records its session and final reply (`api.automations.runs(id)`).

## Schedules

| Schedule | Meaning |
|---|---|
| `5m`, `1h`, `every 1h30m`, `2d` | An interval (at least 1 minute), counted from the last time it was due |
| `daily 09:00` | Every day at that time |
| `weekdays 08:30` | Monday to Friday at that time |
| `0 9 * * 1-5` | A five-field cron expression |

Times are in a `timezone` (an IANA name such as `Europe/London`; by default the server's). A daily time stays at that local time when the clocks change. A command's `every` is an interval. Reins checks for due automations every 30 seconds, so a delivery or check can start up to 30 seconds late. A command automation is checked first at once.

**When Reins was down** at a due time, the automation fires once when Reins starts again, not once for each time it missed.

## Cancel

- **Ask the agent:** *"Stop watching the PR."* It calls `api.automations.cancel(id)`. To find the ID, it calls `api.automations.list()` (the automations that message this session or that it made) or `api.automations.list({ all: true })`.
- **Archive or delete the session.** This cancels the automations that message it. (It does not cancel those with their own session that it made.)
- **Over HTTP:** `POST /api/extensions/automations/cancel` with `{ "id": … }` (the later Automations tab uses this).

A cancelled automation never fires again. Its run history stays: `api.automations.list({ all: true, includeCancelled: true })` shows who or what cancelled it.

## Limits

- A message steered into a running session is lost if the user stops that run before the model reads it.
- If the session is in a long tool call (a build), the model reads the message when that call ends.
