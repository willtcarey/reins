# Manual AgentHarness Pi sandbox

Use this launcher to exercise the registered AgentHarness-based Pi runtime implementation without opening the production server or database.

## Safety boundaries

The launcher creates a fresh disposable directory under `/tmp` and prints it. Inside that directory it creates:

- `data/reins.db` — a newly migrated Reins SQLite database;
- `project/` — the only project cwd;
- `home/` — isolated `HOME`, `USERPROFILE`, and XDG configuration/data roots.

It sets `REINS_DATA_DIR` and all home/config roots before dynamically importing Reins or Pi modules, enables `PI_OFFLINE=1`, clears common provider-key environment variables, registers only a fake provider, and supplies no credentials. It constructs the runtime directly rather than registering production session creation, migrating history, or starting an HTTP/UI server.

Only the `read` tool is enabled and it is rooted in the disposable project. Bash, write, edit, execute, create_task, and cross-session tools are unavailable.

## Automated fake prompt and reopen

From the repository root:

```sh
bun run --cwd packages/backend manual:agent-harness-pi
```

The launcher performs one fake prompt, closes the runtime, reopens the same canonical harness session, performs a second fake prompt, and prints:

- `SANDBOX_ROOT=...`
- `DATABASE=...`
- `PROJECT=...`
- the projected messages
- `FAKE_REOPEN_OK`

Delete the printed `SANDBOX_ROOT` when finished.

To choose an empty disposable location explicitly:

```sh
ROOT="$(mktemp -d /tmp/reins-agent-harness-manual-XXXXXX)"
bun run --cwd packages/backend manual:agent-harness-pi -- --root "$ROOT"
```

## Direct interactive commands

```sh
bun run --cwd packages/backend manual:agent-harness-pi -- --interactive
```

After the automatic reopen check, available commands are:

```text
prompt <text>
messages
reopen
close
exit
```

`prompt` adds a deterministic fake response. `messages` uses the runtime's direct asynchronous transcript projection. `reopen` closes and reconstructs the runtime directly. `close` is idempotent. Steering and abort are covered by automated fake-provider acceptance tests but are not exposed by this small launcher because its fake responses settle immediately.

Real-provider testing is intentionally not configured. It requires a separate user choice of model and isolated authentication flow; do not copy credentials into this sandbox or remove offline mode casually.
