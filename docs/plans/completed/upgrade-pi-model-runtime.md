# Upgrade Pi model runtime

Upgrade `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from 0.80.6 to the current compatible release without changing Reins runtime behavior.

## Goals

- Adopt Pi's current model runtime interface after removal of the `AuthStorage` / `ModelRegistry` session interface.
- Keep API-key and OAuth credentials backed by Reins SQLite.
- Source model listing and selection from Pi's current runtime catalog so new models arrive through catalog refresh rather than Reins-maintained model declarations.
- Preserve session creation, SQLite transcript resume, compaction, utility prompts, live credential visibility, and existing runtime event behavior.
- Verify `openai-codex` includes GPT-6 Astra.
- Map Reins `max` thinking to Pi's native `max` level.

## Completed implementation

- [x] Upgraded both Pi packages to 0.85.1.
- [x] Added contract coverage for GPT-6 Astra, remote model-catalog discovery, and native max thinking.
- [x] Replaced removed auth/model session objects with Pi `ModelRuntime` and a Reins SQLite `CredentialStore`.
- [x] Migrated OAuth login orchestration to provider auth exposed by `ModelRuntime`.
- [x] Updated session, utility prompt, live model selection, model listing, and test helper wiring.
- [x] Preserved SQLite resume and compaction behavior under the existing full runtime suite.
- [x] Updated runtime and settings documentation.
- [x] Passed full tests, typecheck, and lint.
