# Skills

Skills are reusable instruction packages you can add to your machine or repository so REINS agents can pick them up automatically.

A skill is usually a directory containing a `SKILL.md` file plus optional scripts/docs/assets used by that skill.

## Where to put a skill so REINS discovers it

REINS has its own resource loader for skill discovery. Skills are discovered from:

- Global: `~/.agents/skills/`
- Project: `<cwd>/.agents/skills/`

For project-local skills, put them in your repo, for example:

```text
my-project/
  .agents/
    skills/
      api-review/
        SKILL.md
```

REINS will include discovered skills in the session's `<available_skills>` block.

## Minimal skill structure

```text
my-skill/
  SKILL.md            # required
  scripts/            # optional
  references/         # optional
```

Only `SKILL.md` is required.

## How to write `SKILL.md`

`SKILL.md` should start with frontmatter containing `name` and `description`.

~~~markdown
---
name: my-skill
description: One clear sentence explaining what this skill does and when to use it.
---

# My Skill

## When to use
Use this for ...

## Steps
1. ...
2. ...

## Commands
```bash
./scripts/run.sh <arg>
```
~~~

### Frontmatter rules (important)

- `name` is required
- `description` is required
- name should be lowercase letters, numbers, and hyphens
- name should match the skill directory name
- `disable-model-invocation: true` (optional) — hides the skill from the `<available_skills>` listing in the system prompt, so the model won't load it on its own. The skill can still be injected manually via slash commands.

If description is missing, the skill will not be loaded.

## Writing instructions that work well

- Be explicit about **when** to use the skill (this affects whether the model selects it).
- Give concrete, copy-pasteable commands.
- Use **relative paths** inside the skill (for scripts/docs/assets).
- Keep setup steps separate from execution steps.
- Include troubleshooting notes for common failures.

## Example

```text
.agents/skills/openapi-diff/
  SKILL.md
  scripts/compare.sh
```

~~~markdown
---
name: openapi-diff
description: Compare two OpenAPI specs and summarize breaking changes. Use when reviewing API version updates.
---

# OpenAPI Diff

## Run
```bash
./scripts/compare.sh old.yaml new.yaml
```

## Output checklist
- Breaking endpoints
- Request/response schema changes
- Auth changes
~~~

## Using skills

### Automatic (model-driven)

By default, discovered skills appear in the `<available_skills>` block in the system prompt. The model reads this list and decides when to load a skill's `SKILL.md` via the read tool based on the task at hand. You can prevent a skill from appearing in this list by setting `disable-model-invocation: true` in the frontmatter.

### Slash commands (user-driven)

You can explicitly inject a skill by typing `/name` in your message, where `name` matches a skill's name. For example:

```
/dip start the rails server
```

This injects the full content of the `dip` skill into the conversation context so the model has the skill's instructions available immediately — no read tool call needed.

Slash commands:

- Work on any turn, not just the first message.
- Can appear anywhere in the message text.
- Support multiple skills in one message (e.g., `/dip /tmux start the server and check the logs`).
- Must be standalone tokens — `/dip` triggers but `docker/dip` does not.
- Tab-complete in the input as you type.
- Work for all skills, including those with `disable-model-invocation: true`.

## Notes

- Skills are discovered at session startup; if you add/change a skill, start a new session to ensure the latest version is picked up.
- If two discovered skills share the same name, only one is kept (first discovered wins).
