# Local Meridian service

Meridian (`@rynfar/meridian`) provides a local Claude endpoint backed by the
Claude Code Agent SDK and the signed-in Claude subscription. It is an external
service, not part of the Reins backend. On Will's dev machine it listens on
`http://127.0.0.1:3456`; the browser dashboard uses the same address.

The inspected installation is version 1.78.0, installed globally through mise's
Node installation. Use `command -v meridian` to locate the current executable.
The Claude backend uses Meridian's bundled Claude Code executable.

## Start and inspect

Run from the Reins checkout:

```bash
mkdir -p /tmp/agent-tmux-sockets
tmux -S /tmp/agent-tmux-sockets/agent.sock new-session -d \
  -s reins-meridian -c "$PWD" 'meridian; exec zsh'
```

This is a manually started service, not a boot-enabled service. Start it again
after reboot. Before starting a second instance, check the listener:

```bash
ss -ltnp | grep ':3456'
curl -sS http://127.0.0.1:3456/health
```

Attach to inspect output or stop the service with Ctrl+C:

```bash
tmux -S /tmp/agent-tmux-sockets/agent.sock attach -t reins-meridian
```

Restart by stopping the running process and running `meridian` in that pane.

## Failed message diagnosis

The health endpoint checks service availability and credential metadata; a
`healthy` / `loggedIn: true` response does **not** prove Claude can authenticate
an inference request. Inspect recent requests and diagnostic logs:

```bash
curl -sS 'http://127.0.0.1:3456/telemetry/requests?limit=15'
curl -sS 'http://127.0.0.1:3456/telemetry/logs?limit=35'
```

Observed authentication failures surfaced to clients as HTTP 500 `api_error`
with no generated content. The diagnostic logs contained:

- `Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh`
- `Failed to authenticate: OAuth session expired and could not be refreshed`

A refresh conflict can be transient. If retrying after a minute does not help,
check for other Claude Code processes and sign in again. Do not kill unrelated
sessions or delete credentials blindly.

## Renew Claude authentication

Use the explicit authentication subcommand, **not** `claude login` (which can
launch an interactive coding session with `login` as its prompt):

```bash
claude auth login
claude auth status
```

For remote/agent-assisted sign-in, run the login in tmux:

```bash
tmux -S /tmp/agent-tmux-sockets/agent.sock new-session -d \
  -s meridian-login 'claude auth login; exec zsh'
tmux -S /tmp/agent-tmux-sockets/agent.sock attach -t meridian-login
```

Open the URL printed by the command, authorize the account, and paste the
returned code into its prompt. Treat authorization codes and tokens as secrets;
do not put them in docs, commits, or persistent logs. Confirm `Login successful`
and `claude auth status`, then restart Meridian and retry a client message to
verify end-to-end recovery. A health check alone is insufficient.

Local Meridian state is under `~/.cache/meridian` and configuration under
`~/.config/meridian`. Claude authentication uses `~/.claude`; avoid dumping
credential files during diagnosis.
