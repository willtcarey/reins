# Reins System Prompt

Status: **design** — not ready for implementation.

## Problem

Agents running in Reins identify as pi — "You are an expert coding assistant operating inside pi, a coding agent harness." This is pi's default system prompt, baked into the SDK's `buildSystemPrompt()` function. Reins appends additional instructions via `appendSystemPromptOverride`, but the core identity comes from pi and sets the wrong tone.

This causes agents to:
- Reference "the pi UI" when they should say Reins
- Not know they can use the `search` and `execute` tools for Reins operations
- Not understand they're running inside a system with projects, tasks, and sessions

## Source

Pi's system prompt is built in `dist/core/system-prompt.js`:

```
You are an expert coding assistant operating inside pi, a coding agent harness.
```

This is the first line the agent sees. Everything Reins appends comes after.

## Approach

Use `systemPromptOverride` on `DefaultResourceLoader` to **replace** the base system prompt entirely rather than appending to it. This gives Reins full control over agent identity and behavior instructions.

```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd: projectDir,
  systemPromptOverride: (_base) => buildReinsSystemPrompt(task),
});
```

The `_base` parameter (pi's default prompt) is ignored. Reins provides its own from scratch.

## What the Reins system prompt should include

**Identity:**
- You are a Reins agent, not pi. Reins is built on the pi SDK but you interact with users through Reins.
- You are running inside a project with access to its codebase, tasks, and sessions.

**Reins API awareness:**
- Use the `search` tool to discover available Reins API operations (projects, tasks, sessions, messages).
- Use the `execute` tool to run operations against the Reins API.
- Prefer `search`/`execute` for Reins data operations over raw HTTP or bash.

**Tool descriptions:**
- Retain pi's tool documentation (read, bash, edit, write descriptions) since those come from the tools themselves, not the system prompt.
- Add guidance for Reins-specific tools (create_task, delegate, search, execute).

**Context behavior:**
- Retain pi's useful instructions about skills, extensions, prompt templates — those still apply since Reins uses pi's resource loader.
- Keep the AGENTS.md and context file injection — those are handled by the resource loader and should continue to work.

**Task vs scratch session behavior:**
- Task sessions: include task title/description, "you are working on this task" framing.
- Scratch sessions: "focus on analysis and explanation first, implementation work should go in tasks."
- This is already in `appendSystemPromptOverride` — move it into the main prompt.

## What to preserve from pi's prompt

Pi's system prompt includes useful things beyond identity:
- Tool usage patterns and conventions
- Instructions about reading docs before implementing
- Skill and extension awareness

These should be reviewed and selectively included rather than lost. The override replaces the *whole* base prompt, so anything useful needs to be carried over explicitly.

## Open questions

1. **Maintaining compatibility with pi updates** — If pi improves its system prompt in a new version, we won't get those improvements automatically since we're overriding. Need a strategy for reviewing pi prompt changes on upgrades.
2. **Per-project customization** — Should the system prompt be customizable per project (via a config file in the repo)? AGENTS.md already serves this role to some extent.
3. **How much of pi's prompt to keep** — Need to carefully diff pi's default prompt and decide what to carry over vs what to drop. Some of it may be model-specific (e.g., Claude-specific instructions).
