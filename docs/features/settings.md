# Settings

REINS stores global configuration in its SQLite database.

## Default model

The **Default Model** setting controls which model new sessions use.

- It is global to the server, not per-project.
- It applies to newly created sessions only.
- Existing sessions keep their current model unless changed explicitly.
- If no default model is configured, the pi SDK's built-in default is used.

You can change the default model from the settings panel in the sidebar using a single provider/model picker.

## API keys

Provider API keys can also be managed from the settings panel.

- Keys stored in the database are encrypted at rest.
- Environment variables like `ANTHROPIC_API_KEY` still work as provider-key fallbacks.
- Database-managed keys take precedence over environment variables.

## Per-session model changes

Agents can change a session's model via the scripting API (`sessions.setModel(...)`). That only affects the targeted session, not the global default.

If the session is currently open, the change is applied live for the next LLM turn and broadcast to connected clients. If the session is inactive, the stored session metadata is updated so bulk operations like moving all sessions on a task to a new model work without reopening them first.
