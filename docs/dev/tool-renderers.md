# Tool Renderers

The `tool-renderers/` directory in the frontend provides tool-specific inline renderings for agent tool calls in the chat panel. Each tool (read, bash, edit, write, create_task, delegate) has a dedicated renderer that owns its full visual output, replacing the old generic JSON-dump display.

## Architecture

### ToolRenderer Interface

Every renderer implements two methods:

```ts
interface ToolRenderer {
  renderRunning(block: ToolBlockData): TemplateResult;
  renderDone(block: ToolBlockData): TemplateResult;
}
```

Renderers own the **entire visual surface** for a tool block — layout, chrome, expand/collapse behavior (including expansion state), syntax highlighting. The chat panel is not involved in tool expansion state. This avoids locking all tools into one interaction pattern.

### Registry & Dispatch

`tool-renderers/index.ts` maps tool names to renderers with a generic fallback:

```ts
const toolRenderers: Record<string, ToolRenderer> = {
  read: readRenderer,
  bash: bashRenderer,
  edit: editRenderer,
  write: writeRenderer,
  create_task: createTaskRenderer,
  delegate: delegateRenderer,
};

export function getToolRenderer(name: string): ToolRenderer {
  return toolRenderers[name] ?? genericRenderer;
}
```

`chat-panel.ts` dispatches in ~5 lines:

```ts
private renderToolBlock(block: ToolBlockData) {
  const renderer = getToolRenderer(block.name);
  const content = block.status === "running"
    ? renderer.renderRunning(block)
    : renderer.renderDone(block);
  return html`<div class="max-w-[90%]">${content}</div>`;
}
```

### File Layout

```
src/tool-renderers/
  index.ts                  — registry + getToolRenderer()
  types.ts                  — ToolRenderer interface
  generic.ts                — fallback pure helpers + renderer entry
  generic-tool-block.ts     — Lit component: JSON args + raw result
  read.ts                   — pure helpers for read tool
  read-tool-block.ts        — Lit component with lazy syntax highlighting
  bash.ts                   — pure helpers for bash tool
  bash-tool-block.ts        — Lit component: terminal-style block
  bash-command-parser.ts    — shell command tokenizer for syntax coloring
  edit.ts                   — pure helpers, diff parsing, auto-expand logic
  edit-tool-block.ts        — Lit component with inline diff + lazy highlighting
  write.ts                  — pure helpers for write tool
  write-tool-block.ts       — Lit component with syntax highlighting
  create-task.ts            — pure helpers for create_task tool
  create-task-tool-block.ts — Lit component: card-style with emerald accent
  delegate.ts               — pure helpers for delegate tool
  delegate-tool-block.ts    — Lit component: card-style with purple accent
```

## Rendering Pattern

Every renderer follows the same two-file pattern:

1. **`<tool>.ts`** — Pure helper functions (data extraction from `ToolBlockData`) + the `ToolRenderer` entry point that extracts data and passes primitives to a custom element.
2. **`<tool>-tool-block.ts`** — A `LitElement` custom element that receives primitive props and owns all rendering, interaction, and expansion state. Has no knowledge of `ToolBlockData`.

The renderer extracts all data and passes it as primitive props:

```ts
// read.ts
export const readRenderer: ToolRenderer = {
  renderRunning(block) {
    const path = getReadSummary(block);
    return html`<read-tool-block .path=${path} .showSpinner=${true}></read-tool-block>`;
  },
  renderDone(block) {
    const path = getReadSummary(block);
    const content = getReadContent(block);
    const preview = getReadPreview(block);
    // ... extract all data, pass as props
    return html`<read-tool-block .path=${path} .content=${content} .preview=${preview} ...></read-tool-block>`;
  },
};
```

This gives a clean one-way data flow: `ToolBlockData → renderer (extracts) → component (renders)`. Components are pure presentational and have no imports from their renderer files — no circular dependencies.

Each tool block component manages its own `@state() expanded` property — the chat panel has no knowledge of tool expansion state. This means a tool renderer can choose not to expand at all, auto-expand based on content size, or implement any interaction pattern it wants.

## Data Flow & Testing

Each renderer file has **pure helper functions** that extract data from `ToolBlockData`. These are the primary test surface — tested without any DOM in `__tests__/tool-renderer-<name>.test.ts`:

```
read.ts       → getReadSummary(), getReadPreview(), getReadContent(), getReadLineCount(), ...
bash.ts       → getBashCommand(), getBashPreview(), getBashOutput(), getBashExitInfo()
edit.ts       → getEditSummary(), getEditStats(), getEditDiffLines(), parseDiffString(), ...
write.ts      → getWriteSummary(), getWriteInfo(), getWriteContent()
create-task.ts → getTaskSummary(), getTaskDetail()
delegate.ts   → getDelegateSummary(), getDelegateDetail()
```

The renderer calls these helpers, then passes the results as primitive props to the component. The component never touches `ToolBlockData` — it only receives strings, numbers, booleans, and simple typed arrays.

Shared types like `ToolResultImage` live in `types.ts` alongside the `ToolRenderer` interface.

## Interaction Patterns

Each tool chooses its own expand/collapse UX:

| Tool | Collapsed | Expanded | Toggle target |
|------|-----------|----------|---------------|
| **read** | File path + first 4 lines preview | Full content (scrollable) | Card-click to expand, header-click to collapse |
| **bash** | Command with `$` prompt | Command + output below divider | Whole block click |
| **edit** | File path + `+N −M` stats badge | Inline diff with context lines | Header click (small diffs auto-expand) |
| **write** | File path + first 4 lines preview | Full content, all lines as additions | Card-click to expand, header-click to collapse |
| **create_task** | Task title + branch name | Description + result | Whole block click |
| **delegate** | Truncated prompt (2 lines) | Full prompt + result | Whole block click |

## Lazy Syntax Highlighting

The `read`, `edit`, and `write` tool blocks use `LazyHighlightController` (see [reactive-controllers.md](reactive-controllers.md)) to defer Shiki syntax highlighting until the element scrolls into view. This prevents old tool calls from triggering expensive highlighting on chat load.

The pattern in each tool block component:

```ts
private _hl = new LazyHighlightController(this, () => {
  const path = getPath(this.block);
  if (!path || this.block.isError) return null;
  return { path, hunk: { header: "", lines: buildLines(this.block) } };
});
```

The controller handles IntersectionObserver setup, cache-key deduplication, and `host.requestUpdate()` when highlighting completes.

## Edit Tool: Auto-Expand & Diff Parsing

The edit renderer has two notable behaviors:

### Auto-expand for small diffs

Diffs with ≤ 20 lines (`AUTO_EXPAND_THRESHOLD`) start expanded automatically. `shouldAutoExpand()` makes this decision when the block first arrives, setting the component's internal `expanded` state. After that, the user can toggle freely — there's no special tracking of "manually collapsed" vs "auto-expanded".

### Server-computed diffs

When available, the edit renderer uses `details.diff` from the tool result (server-computed unified diff with context lines) rather than the naive all-remove/all-add fallback. `parseDiffString()` parses the pi SDK's diff format (`+lineNum text`, `-lineNum text`, ` lineNum text`, ellipsis separators) into `DiffLine[]`.

## Bash Command Parser

`bash-command-parser.ts` tokenizes shell commands for syntax highlighting. It splits on operators (`|`, `&&`, `||`, `;`) with quote awareness, identifies the command word (skipping prefixes like `sudo`, `env`, and env-var assignments), and tags segments as `command`, `args`, or `operator` for color-coding in the terminal block.

## Adding a New Tool Renderer

1. Create `tool-renderers/<name>.ts` with pure helper functions for extracting data from `ToolBlockData`
2. Create `tool-renderers/<name>-tool-block.ts` as a `LitElement` custom element that receives **primitive props only** — no `ToolBlockData` import
3. Export a `ToolRenderer` in `<name>.ts` that extracts all data via helpers and passes primitives to the custom element
4. Register in `tool-renderers/index.ts` — add to the `toolRenderers` map and exports
5. Add tests in `__tests__/tool-renderer-<name>.test.ts` covering the pure helpers
