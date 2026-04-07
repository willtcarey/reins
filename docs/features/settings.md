# Settings

REINS stores global configuration in its SQLite database.

## Default model

The **Default Model** setting controls which model new sessions use.

- It is global to the server, not per-project.
- It applies to newly created sessions only.
- Existing sessions keep their current model unless changed explicitly.
- If no default model is configured, REINS uses its built-in fallback.
- If a default model is configured but no longer exists, new sessions fail with an error until you update the setting.

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

- App settings like the default model are stored separately from provider credentials.
- Stored credentials are encrypted at rest.
- Environment variables like `ANTHROPIC_API_KEY` still work as fallbacks when no database credential is configured.
- Database-managed API keys take precedence over environment variables.

API keys and OAuth sign-in are managed from the app's authentication flows.

## Per-session model changes

Each chat session has its own **Session model** control near the message composer.

- It changes the model for the current session only.
- It does not modify the global default used for future sessions.
- It can change both the selected model and the thinking level for the session.
- The change applies on the next turn if a response is already in flight.
- It includes a shortcut to apply the current global default model to the session.

Changing a session model only affects that session, not the global default.

If the session is currently open, the change is applied live for the next LLM turn. If the session is inactive, REINS stores the new model so it takes effect the next time the session is used.
