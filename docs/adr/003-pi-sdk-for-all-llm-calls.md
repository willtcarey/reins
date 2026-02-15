# ADR-003: Use Pi SDK for All LLM Calls

- **Status:** Accepted
- **Date:** 2026-02-15
- **Author:** Will (with Claude)

## Context

Branch name generation was implemented using the `@anthropic-ai/sdk` directly,
creating a second authentication path alongside the Pi SDK that already powers
agent conversations. This meant:

1. **Duplicate auth configuration.** Pi manages API keys via its own
   `AuthStorage` (`~/.pi/agent/auth.json`). The Anthropic SDK resolves keys
   from `ANTHROPIC_API_KEY`. Users had to ensure both were set up.
2. **Provider lock-in.** The direct SDK call hardcoded Anthropic (Haiku).
   Pi already abstracts over providers — if the user configures a different
   provider, the branch namer wouldn't follow.
3. **Extra dependency.** `@anthropic-ai/sdk` was pulled in solely for this
   one call.

## Decision

**All LLM calls go through Pi agent sessions.** For lightweight, non-interactive
uses (like branch name generation), create a minimal throwaway session:

```ts
const { session } = await createAgentSession({
  tools: [],
  model: getModel("anthropic", "claude-haiku-4-5"),
  sessionManager: SessionManager.inMemory(),
  resourceLoader: { /* inline loader with task-specific system prompt */ } as any,
});

await session.prompt(input, { expandTemplates: false });
const text = session.getLastAssistantText();
session.dispose();
```

This reuses Pi's auth, model selection, and provider abstraction with no
additional dependencies.

## Consequences

- **Removed `@anthropic-ai/sdk`** as a direct dependency of the backend.
- Any future LLM utility calls (summarization, classification, etc.) should
  follow this same pattern: throwaway Pi session, no tools, custom system
  prompt via inline resource loader.
- Utility calls should explicitly choose a model via `getModel()` from
  `@mariozechner/pi-ai` rather than falling through to Pi's default
  resolution. The caller knows the task complexity and should pick
  accordingly (e.g. Haiku for branch names, something heavier for
  summarization).
