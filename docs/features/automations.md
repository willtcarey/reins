# Automations

Automations wake sessions up on a schedule. They come from the built-in **automations** extension ([extensions.md](extensions.md)). There are two kinds, with one mechanism: each time a schedule is due, Reins sends a message to a session.

- A **wake-up** sends a message to the session that asked for it. Use it to monitor something: "check this PR until it merges".
- A **heartbeat** sends a prompt to a hidden session of its own, which it keeps across runs. Use it for a routine: "every morning, list my new GitHub notifications".

There is no Automations tab yet. You ask an agent, and the agent uses `api.automations` (in `execute`; it finds the functions with `search`). Settings → Extensions shows the extension, its functions and its **scheduler** service.

## Wake-ups: "monitor this until it merges"

Ask the agent in the session, for example: *"Check PR 42 every 10 minutes and tell me when it merges."* The agent calls `api.automations.wake({ schedule: "10m", message: "…" })`.

- Each time it is due, the message comes into the chat as a message **from automations**. The session then runs as if you sent it. The message ends with a note of the wake-up's ID and how to cancel it.
- **A busy session is skipped.** If the session is running when a wake-up is due, that wake-up is not sent (it is not queued). The next one is sent as usual. The run history records the skip.
- **No expiry.** A wake-up continues until it is cancelled. The agent should cancel it when its work is done (for example, when the PR merged).

## Heartbeats: "every day, check my notifications"

Ask any agent, for example: *"Every day at 09:00 London time, list my new GitHub notifications."* The agent calls `api.automations.heartbeat({ name, schedule: "daily 09:00", timezone: "Europe/London", prompt })`.

- The heartbeat starts its **hidden session** at once, with the first run. Each later run sends the prompt to the **same** session, so a run can see what earlier runs found ("new since the last run"). The browser does not show hidden sessions.
- By default the session works in the directory of the session that asked, with no project. The agent can give another location (`source`) and a model (`model`).
- **Each run's output is its final reply.** The agent reads them with `api.automations.runs(id)`: when each run started and ended, its outcome (`completed`, `failed`, `skipped` while the last run still ran, `lost` when Reins restarted during the run), and its output or error. A heartbeat also shows how many of its latest runs failed in a row (`consecutiveFailures`).
- **Compaction.** The model compacts the session by itself near its context limit. A heartbeat can set a lower limit (`compactAboveTokens`): after a run that ends above it, Reins compacts the session, and the summary keeps what later runs need.
- **A broken session.** If the session goes wrong, ask the agent to replace it (`api.automations.replaceSession(id)`). The next run starts a new hidden session. If the hidden session is deleted, the next run also starts a new one.

## Schedules

| Schedule | Meaning |
|---|---|
| `5m`, `1h`, `every 1h30m`, `2d` | An interval (at least 1 minute), counted from the last time it was due |
| `daily 09:00` | Every day at that time |
| `weekdays 08:30` | Monday to Friday at that time |
| `0 9 * * 1-5` | A five-field cron expression |

Times are in a `timezone` (an IANA name such as `Europe/London`; by default the server's). A daily time stays at that local time when the clocks change. Reins checks for due automations every 30 seconds, so a run can start up to 30 seconds late.

**When Reins was down** at a due time, the automation runs once when Reins starts again, not once for each time it missed.

## Cancel

- **Ask the agent:** *"Stop checking the PR."* It calls `api.automations.cancel(id)`. To find the ID, it calls `api.automations.list()` (this session's wake-ups and the heartbeats it made) or `api.automations.list({ all: true })`.
- **Archive or delete the session.** This cancels its wake-ups. (It does not cancel the heartbeats that the session made.)
- **Over HTTP:** `POST /api/extensions/automations/cancel` with `{ "id": … }` (the later Automations tab uses this).

A cancelled automation is never due again. Its run history stays: `api.automations.list({ all: true, includeCancelled: true })` shows who or what cancelled it.
