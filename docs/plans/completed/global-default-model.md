# Global Default Model & API Key Management

Status: **completed**

## Goal

Store global default model and API keys in the database. Provide a settings UI (gear icon in the sidebar) for managing both. Allow agents to change their session's model mid-conversation via the `execute` tool. Model selection should be driven through DB-backed settings rather than `REINS_PROVIDER` / `REINS_MODEL` env vars.

## Design

### Two levels of model selection

1. **Global default** — what new sessions get. Stored in DB, changed via settings UI.
2. **Per-session override** — agent changes its own model mid-turn via `sessions.setModel()` in the `execute` tool.

### API key management

API keys stored in the `settings` table, bridged to the pi SDK via `authStorage.setRuntimeApiKey()` which takes highest priority in the SDK's key resolution chain:

1. Runtime override (`setRuntimeApiKey`) ← **our DB keys go here**
2. API key from auth.json
3. OAuth token from auth.json
4. Environment variable ← **existing env vars still work as fallback**
5. Fallback resolver

DB keys win over env vars, but env vars still work when no DB key is set. Zero breaking changes for existing deployments.

**Encryption:** API keys are encrypted at rest in SQLite using AES-256-GCM. The encryption key is derived from a server secret — either `REINS_SECRET` env var or an auto-generated key stored in `<data_dir>/secret.key`. This matches the security posture of env vars (both require filesystem/process access to read) while protecting against casual DB inspection.

### Typed settings store

All non-secret settings are defined in a single TypeBox schema registry. The registry is just `setting key -> value schema`, and the store uses it for key discovery, type inference, and runtime validation.

```ts
const SETTINGS_SCHEMA = {
  default_model: Type.Object({
    provider: Type.String(),
    modelId: Type.String(),
    thinkingLevel: Type.String(),
  }),
  utility_model: Type.Object({
    provider: Type.String(),
    modelId: Type.String(),
    thinkingLevel: Type.String(),
  }),
} as const;
```

The schema does double duty:
1. **TypeScript types** — `getSetting("default_model")` returns the typed model-setting object for that key
2. **Runtime validation** — `getSetting()` and `setSetting()` validate stored values against the schema for the requested key

Secret material is intentionally kept out of the settings table. API keys and OAuth credentials live in `auth_credentials`, where encryption and redaction are handled separately.

Adding a new non-secret setting is one entry in the registry.

### Generic settings API

One endpoint set handles all settings:

- `GET /api/settings` — all settings (values redacted where flagged)
- `GET /api/settings/:key` — single setting (redacted if flagged)
- `PUT /api/settings/:key` — set a setting (store validates, encrypts, applies side effects)
- `DELETE /api/settings/:key` — remove a setting (store applies side effects)

Plus one read-only derived data endpoint:

- `GET /api/models` — available providers and models (not a setting, just discovery data for the UI)

### Behavior matrix

| Scenario | Model used |
|---|---|
| New session, global default set | Global default from `default_model` setting |
| New session, global default not set | Pi SDK built-in default |
| Resumed session | Session's stored model from `sessions` table |
| Agent calls `sessions.setModel()` | Takes effect on the next LLM turn |
| User changes global default in settings | Only affects future sessions |

### Why `setModel()` mid-turn is safe

The pi SDK's `setModel()` just sets `this._state.model = m`. The current turn finishes with whatever LLM call is already in flight. The new model is used on the next turn. Since `execute` runs as a tool call mid-turn, the timeline is:

1. LLM responds with tool calls (old model)
2. `execute` runs → `setModel()` swaps the model property
3. Agent sends tool results to LLM → next turn uses the new model

No race conditions, no interrupted streams.

## Implementation

The phases are ordered so that the running instance is never broken. All new code is additive and inert until the final wiring phase. The UI and API are built and testable first, then we flip the switch.

### Phase 1: Settings table, store, and encryption

✅ 1. Add migration 014 to `migrations.ts` — create `settings` table:
   ```sql
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )
   ```
✅ 2. Create `crypto.ts` with `getOrCreateSecret(dataDir)`, `encrypt(plaintext, secret)`, `decrypt(encrypted, secret)`. Write tests for round-trip encryption, different secrets produce different output, tampered ciphertext throws.
✅ 3. Define the `SETTINGS_SCHEMA` registry in `settings-store.ts` with `default_model`, `api_key_anthropic`, `api_key_openai`, `api_key_openrouter` entries and their behavior flags.
✅ 4. Implement `getSetting()` — read from DB, deserialize JSON for object schemas, decrypt if `encrypted` flag set. Test: returns null for missing key, returns typed object for `default_model`, returns decrypted string for `api_key_*`.
✅ 5. Implement `setSetting()` — validate against TypeBox schema, serialize JSON for objects, encrypt if `encrypted` flag set, upsert to DB. Test: round-trips with `getSetting`, rejects invalid data (wrong type, missing fields), encrypted values are not plaintext in DB.
✅ 6. Implement `deleteSetting()` — remove from DB. Test: get returns null after delete.
✅ 7. Implement `listSettings()` — return all stored settings, redact values where `redacted` flag set. Test: API keys show as `"********"`, non-redacted values shown normally.

### Phase 2: Settings and models API routes

✅ 1. Add `settings: "/api/settings"` and `models: "/api/models"` to `api-paths.ts`.
✅ 2. Create `routes/settings.ts` with `GET /api/settings` — calls `listSettings()`, returns JSON. Test: returns empty array when no settings, returns redacted values after setting API keys.
✅ 3. Add `GET /api/settings/:key` — calls `getSetting()`, returns value or 404. For redacted keys, return `{ configured: true }` instead of the value. Test: returns 404 for missing key, returns value for `default_model`, returns `configured: true` for API keys.
✅ 4. Add `PUT /api/settings/:key` — parse body, call `setSetting()`, return 200. Test: round-trips with GET, returns 400 for invalid key name, returns 400 for invalid value shape.
✅ 5. Add `DELETE /api/settings/:key` — call `deleteSetting()`, return 204. Test: GET returns 404 after delete.
✅ 6. Register settings routes in `routes/index.ts`.
✅ 7. Create `routes/models.ts` with `GET /api/models` — query pi-ai `getProviders()` and `getModels()`, check `hasKey`/`keySource` for each provider. Test: returns expected provider/model structure, `hasKey` reflects configured keys.
✅ 8. Register models route in `routes/index.ts`.

### Phase 3: Frontend settings UI

✅ 1. Create `components/settings-panel.ts` — Lit component, two sections (API Keys, Default Model).
✅ 2. Add settings gear icon to the sidebar (`project-sidebar.ts` or equivalent). Clicking opens the settings panel.
✅ 3. **API Keys section:** Fetch `GET /api/settings` on open. For each provider in the schema, show a row with provider name, status indicator, and masked text input. Wire blur/enter to `PUT /api/settings/api_key_<provider>`. Wire delete button to `DELETE /api/settings/api_key_<provider>`. Show "configured via environment" badge for env-var-sourced keys (from `GET /api/models` `keySource` field).
✅ 4. **Default Model section:** Fetch `GET /api/models` for available providers/models. Fetch `GET /api/settings/default_model` for current selection. Render cascading dropdowns: provider → model → thinking level. Wire each dropdown's change event to `PUT /api/settings/default_model` with the full compound value.
✅ 5. Handle loading/error states. Show success feedback on auto-persist (brief checkmark or similar).

At this point the UI is fully functional for viewing and saving settings, but session creation doesn't read from the DB yet. Users can configure everything without risk.

### Phase 4: `sessions.setModel()` and `models.*` in the execute tool API

✅ 1. Create `scripting/models.ts`. Define `models.list()` — returns providers with models, `hasKey`, thinking levels. Same data as `GET /api/models`, shared implementation. Test: returns expected shape, reflects configured keys.
✅ 2. Define `models.listProviders()` — returns just provider names. Test: returns string array.
✅ 3. Register model functions in `api-registry.ts` (`MODEL_FUNCTIONS` added to `API_FUNCTIONS`).
✅ 4. Add `sessions.setModel(sessionId, provider, modelId, thinkingLevel?)` to `scripting/sessions.ts`:
   - Look up `ManagedSession` from `ctx.sessions`
   - Validate session belongs to `ctx.projectId`
   - Resolve `Model` via `getModels(provider).find(m => m.id === modelId)`
   - Call `managed.session.setModel(model)` (pi SDK)
   - If `thinkingLevel` provided, call `managed.session.setThinkingLevel(level)`
   - Update SQLite row (`model_provider`, `model_id`, `thinking_level`)
   - Broadcast `session_updated` event so clients can reload the canonical session state
   - Return the updated session row
✅ 5. Test: setModel updates DB row, invalid provider throws, invalid model throws, session not in project throws, thinkingLevel is optional.

### Phase 5: Wire it all together

✅ 1. Add `authStorage` field to `ServerState` interface in `state.ts`.
✅ 2. In `index.ts` startup: create `AuthStorage` instance, load all `api_key_*` settings, call `authStorage.setRuntimeApiKey()` for each, store on `ServerState`.
✅ 3. In `routes/settings.ts`: after a successful `PUT` or `DELETE` of an `api_key_*` setting, also call `state.authStorage.setRuntimeApiKey()` or `state.authStorage.removeRuntimeApiKey()` to bridge the change to live sessions.
✅ 4. In `sessions.ts` → `buildSessionOpts()`: pass `state.authStorage` to `createAgentSession()` options.
✅ 5. In `sessions.ts` → `buildSessionOpts()`: change model resolution — try `getSetting("default_model")` first, resolve to a `Model` object via `getModels(provider).find()`, otherwise fall back to `undefined` (SDK default).
✅ 6. Test: new session uses DB default model when set. Test: new session falls back to SDK default when no DB default is configured. Test: DB API key is used by sessions (mock `authStorage.setRuntimeApiKey` was called). Test: env var keys still work when no DB key set.

### Phase 6: Cleanup

1. Update `README.md` — document settings UI and `REINS_SECRET`.
2. Add `docs/features/settings.md` covering API key management and default model selection.
3. Move this plan to `docs/plans/completed/`.

## Out of scope

- Per-project model defaults (could layer on later with namespaced settings keys)
- Model cost tracking or usage limits
- OAuth provider login flows (only API key auth for now)
