# Settings

REINS stores global configuration in its SQLite database.

## Default model

The **Default Model** setting controls which model new sessions use.

- It is global to the server, not per-project.
- It applies to newly created sessions only.
- Existing sessions keep their current model unless changed explicitly.
- If no default model is configured, REINS uses its built-in fallback.

You can change the default model from the settings panel in the sidebar using a single provider/model picker.

## Utility model

The **Utility Model** setting controls which model REINS uses for lightweight internal tasks such as task generation and branch naming.

- It is global to the server, not per-project.
- It is intended for cheaper and faster one-shot calls.
- If no utility model is configured, REINS falls back to the default model.
- If neither utility nor default model is configured, REINS uses its built-in fallback.

You can configure it separately in the settings panel, alongside the default model.

## Auth credentials

Provider auth credentials are stored separately from general settings.

- The `settings` table keeps app settings like `default_model`.
- API keys and OAuth credentials live in the `auth_credentials` table.
- Stored credentials are encrypted at rest.
- Environment variables like `ANTHROPIC_API_KEY` still work as fallbacks when no database credential is configured.
- Database-managed API keys take precedence over environment variables.

API keys are managed through dedicated auth endpoints under `/api/auth/api-keys/*`, while OAuth login continues to use `/api/oauth/*`.

## Per-session model changes

Each chat session has its own **Session model** control near the message composer.

- It changes the model for the current session only.
- It does not modify the global default used for future sessions.
- It can change both the selected model and the thinking level for the session.
- The change applies on the next turn if a response is already in flight.
- It includes a shortcut to apply the current global default model to the session.

Agents can also change a session's model via the scripting API (`sessions.setModel(...)`). That only affects the targeted session, not the global default.

If the session is currently open, the change is applied live for the next LLM turn and broadcast to connected clients. If the session is inactive, the stored session metadata is updated so bulk operations like moving all sessions on a task to a new model work without reopening them first.
