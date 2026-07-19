---
name: todo
description: Read and present the current project's docs/TODO.md roadmap. Use when explicitly invoked with /todo.
disable-model-invocation: true
---

# Project TODO

Read `docs/TODO.md` with the `read` tool. Do not use shell commands to display its contents.

## Output

- Start with `Project TODO — N items`, where N is the number of listed items being shown.
- Render the items as a Markdown table with the columns `#`, `Date`, `Item`, and `Details`.
- Use a short descriptive name in `Item` and a concise summary in `Details`.
- Preserve meaningful links, dates, priorities, and qualifiers such as “deprioritised.”
- Condense long implementation detail, but do not change the item's meaning.
- Do not include removed or completed work.

## Filtering

If the user's message includes a topic or search phrase, show only matching items and state that the list is filtered. If no items match, say so plainly.

If the user requests categories or a summary, group related items under short descriptive headings. Otherwise preserve the file's order.

## Scope

This skill reports the repository roadmap in `docs/TODO.md`. Do not mix in Reins task records unless the user explicitly asks for both.

Do not edit the todo file unless the user explicitly asks to add, remove, or revise an item.
