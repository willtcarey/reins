# Skills

Skills are reusable instruction packages you can add to your machine or repository so REINS agents can pick them up automatically.

A skill is usually a directory containing a `SKILL.md` file plus optional scripts/docs/assets used by that skill.

## Where to put a skill so REINS discovers it

REINS uses pi's resource loader for skill discovery. In practice, this means skills are discovered from the same default locations pi uses:

- Global locations:
  - `~/.agents/skills/`
  - `~/.pi/agent/skills/`
- Project locations (starting from the project cwd used by REINS):
  - `.agents/skills/`
  - `.pi/skills/`

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

## Notes

- Skills are discovered at session startup; if you add/change a skill, start a new session to ensure the latest version is picked up.
- If two discovered skills share the same name, only one is kept (first discovered wins).
