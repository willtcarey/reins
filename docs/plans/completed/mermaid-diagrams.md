# Mermaid Diagram Rendering in Markdown

## Problem

Mermaid fenced code blocks (` ```mermaid `) are rendered as plain code in chat messages and diff markdown previews. Users expect to see rendered diagrams.

## Current State

Two places call `marked.parse()`:

1. **`chat-panel.ts`** — `renderMarkdown(text)` calls `marked.parse(text, { async: false })`, returns a Lit `html` template with `unsafeHTML(rendered)`.
2. **`diff-file-card.ts`** — `_fetchMarkdown()` calls `await marked.parse(raw)`, stores the HTML string in `markdownContent`, which is passed to `<diff-markdown-preview>`.

Both render into a `.prose` div.

## Design

### 1. `<markdown-content>` component (`packages/frontend/src/components/markdown-content.ts`)

A Lit component that owns the full markdown lifecycle:

- **Input:** a single `text` string property.
- **Render:** calls `marked.parse(text)` with a custom renderer that outputs `<div class="mermaid">` for mermaid fenced code blocks (instead of `<pre><code>`). Renders the result with `unsafeHTML` inside the standard `.prose` wrapper.
- **Post-render:** in `updated()`, checks for `.mermaid` divs. If found, dynamically imports `mermaid` (code-split via `bun build --splitting`), initializes with `{ startOnLoad: false, theme: "dark" }`, and calls `mermaid.run()`. If none found, does nothing — zero cost.

Call sites just do: `html`<markdown-content .text=${someText}></markdown-content>``

**Streaming:** The component accepts an optional `.streaming` boolean property. During streaming, text changes on every chunk — `marked.parse()` runs each time (same as today), but the mermaid `updated()` step is skipped since the diagram source is incomplete. Once the message finalizes and streaming is false, mermaid diagrams get upgraded. Completed messages (from history, compaction summaries, etc.) never set streaming, so mermaid renders immediately.

Uses light DOM for Tailwind compatibility (same as the rest of the app).

### 2. Integration points

**chat-panel.ts:**
- Remove `marked` import and `renderMarkdown()` method.
- Replace all `${this.renderMarkdown(text)}` calls with `<markdown-content .text=${text}></markdown-content>`.

**diff-file-card.ts:**
- Remove `marked` import. Instead of parsing markdown to HTML and passing the HTML string to `<diff-markdown-preview>`, pass the raw markdown text.

**diff-markdown-preview.ts:**
- Change the `content` property from pre-rendered HTML to raw markdown text.
- Replace the `unsafeHTML(this.content)` render with `<markdown-content .text=${this.content}></markdown-content>`.

### 3. Escaping / security

Mermaid code is user-authored markdown from git repos. The mermaid library itself handles parsing and renders to SVG. The code placed in `<div class="mermaid">` is HTML-escaped by marked. Mermaid's `securityLevel: 'strict'` (default) sanitizes the SVG output.

## Test Plan

- **Unit test** `<markdown-content>`: confirm basic markdown renders to HTML, mermaid blocks produce `<div class="mermaid">` output, and non-mermaid code blocks still produce `<pre><code>`.
- **Existing tests:** `diff-file-card-markdown.test.ts` needs updating — the card no longer stores rendered HTML, it stores raw markdown text. The contract changes from "content contains `<h1`" to "content is raw markdown string".

## File Changes

| File | Change |
|---|---|
| `packages/frontend/src/components/markdown-content.ts` | **New** — `<markdown-content>` component with marked config, mermaid renderer, lazy-load |
| `packages/frontend/src/__tests__/markdown-content.test.ts` | **New** — tests for markdown rendering and mermaid div output |
| `packages/frontend/src/components/chat-panel.ts` | Remove `marked` import and `renderMarkdown()`; use `<markdown-content>` |
| `packages/frontend/src/components/changes/diff-file-card.ts` | Remove `marked` import; store raw markdown instead of parsed HTML |
| `packages/frontend/src/components/changes/diff-markdown-preview.ts` | Accept raw text instead of HTML; use `<markdown-content>` |
| `packages/frontend/src/__tests__/diff-file-card-markdown.test.ts` | Update assertions for new contract (raw text, not HTML) |

## Open Questions

None currently.
