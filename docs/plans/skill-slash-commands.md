# Skill Slash Commands

Status: **early thinking** — not ready for implementation.

Inject skill content into conversation context when a user invokes a slash command matching a skill name (e.g., `/dip start the rails server`).

## Constraints

- Skill content should not appear as visible text in the conversation. A small collapsible UI element (pill/badge) is acceptable.
- Slash commands should work on any turn, not just the first message.
- Slash commands can appear anywhere in the message, not just at the start. Multiple skills in a single message should work (e.g., `/dip /tmux do something`).
- Commands use bare `/name` format (not `/skill:name`). Must be a standalone token — `/dip` triggers but `docker/dip` does not.
- All matched skill content is hoisted to the top of the message (before the user's text), regardless of where the `/name` token appeared. Skills are prompt templates that get pulled in.
- Duplicate invocations of the same skill in one conversation need a sensible strategy (don't waste tokens, but stay resilient across compaction).
- No system prompt rebuilds — the system prompt is set at session creation and should not be mutated for skill injection.

## Current State

Skills are listed in the system prompt as `<available_skills>` with name, description, and file path. The model must use the read tool to load a skill's SKILL.md — there's no way for the user to trigger injection directly.

**PI runtime has native skill expansion** via `_expandSkillCommand()`, but it uses the `/skill:name` format and only matches at the start of the message. We can't use it directly — Reins needs its own expansion that runs before the message reaches either runtime.

## Approach: Expand at the Reins layer, before the runtime

### Detection and expansion

Skill expansion happens in the backend before calling `runtime.prompt()`. The flow:

1. Scan the message for standalone `/name` tokens (word boundary before the `/`, whitespace or end after the name).
2. Match each against `resourceLoader.skills` by name.
3. For each match: read the SKILL.md file, strip frontmatter, wrap in a `<skill>` block.
4. Hoist all skill blocks to the top, followed by the **original user message unchanged**.

The `/name` tokens are left in the user's message — they don't need to be stripped. The model sees the user's exact text plus the skill content above it. The `/dip` token in the message acts as a natural reference to the hoisted skill block. This avoids regex replacement edge cases and keeps the user's intent intact.

Result sent to the model:

```
<skill name="dip" location="/home/user/.agents/skills/dip/SKILL.md">
References are relative to /home/user/.agents/skills/dip.

[SKILL.md body]
</skill>

<skill name="tmux" location="/home/user/.agents/skills/tmux/SKILL.md">
References are relative to /home/user/.agents/skills/tmux.

[SKILL.md body]
</skill>

/dip /tmux start the rails server and check the logs
```

This is consistent with how PI expands skills (same `<skill>` tag format) but handled at the Reins layer so it works for both runtimes.

### Token matching

A `/name` token matches when:
- It is preceded by start-of-string or whitespace (not part of a path like `docker/dip`)
- The name portion matches a known skill name exactly
- It is followed by whitespace or end-of-string

Regex sketch: `(?:^|\s)\/(<skill-names-alternation>)(?=\s|$)`

### What the runtime sees

Both runtimes receive a plain string with skill content already expanded. No changes to `AgentRuntime.prompt()` signature needed. PI's own `_expandSkillCommand` won't trigger because the `/name` tokens have already been removed (and we're not using the `/skill:` prefix).

### Session-level deduplication

For a first implementation, **always re-inject** — if the user types `/dip`, expand it every time. This is the simplest and most predictable behavior. The user explicitly asked for the skill, so give it to them.

Optimize later if token cost becomes a concern. Possible future strategy: track injected skills per session and skip re-injection if the conversation hasn't been compacted since the last injection.

### Frontend display

The backend broadcasts the original user message to other clients (without the expanded skill content). The frontend stores metadata about which skills were injected and renders a small collapsible pill/badge for each (e.g., "dip" with the skill description on expand). The user's message text displays as-is, including the `/name` tokens. The full SKILL.md content is never shown in the conversation.

## Alternatives Considered

**PI's native `/skill:name` expansion** — only matches at start of message, uses a different command format, and inlines content visibly. Doesn't meet our constraints.

**Prepend to user message text without stripping** — skill content appears as visible text in the conversation. Violates the constraint.

**Dynamic system prompt rebuild** — the system prompt is set at session creation and should stay fixed.

**Extend `prompt()` with structured options** — unnecessary complexity since both runtimes accept plain strings and the `<skill>` tag format works inline.

### Tab-completion

The frontend input should suggest available skill names as the user types `/`. This requires the frontend to know the list of available skills — the backend already has this via the resource loader and can serve it over the WS or as a REST endpoint.

## Future Enhancements

- **Inline skill pills** — render `/dip` in the user message as a styled pill/badge. Clicking it opens a popover showing the skill content that was injected. Not necessary for v1 — the raw `/dip` text is clear enough.

## Resolved Questions

- **Should skills injected via slash command suppress the `<available_skills>` listing?** — No. Skills are only excluded from the system prompt listing when they have the `disable-model-invocation` flag in their SKILL.md frontmatter. Slash command injection is independent — a skill can appear in `<available_skills>` (so the model can invoke it on its own) and also be explicitly injected by the user via `/name`.
