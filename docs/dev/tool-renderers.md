# Tool Renderers

Tool-specific inline renderings for agent tool calls in the chat panel. Each tool (read, bash, edit, write, create_task, delegate) has a dedicated renderer that owns its full visual output, replacing the old generic JSON-dump display.

## Architecture

Tool rendering is split across two directories following the [frontend architecture](frontend-architecture.md) dependency rule:

- **`models/tools/`** — Pure data-extraction helpers. Tested without DOM.
- **`components/tools/`** — Lit components + renderer objects. Import from `models/tools/`.

```
models/tools/                      components/tools/
├── read.ts    (getReadSummary,    ├── read.ts    (ReadToolBlock +
│               getReadPreview,    │               readRenderer)
│               getReadContent)    │
├── edit.ts    (getEditStats,      ├── edit.ts    (EditToolBlock +
│               parseDiffString)   │               editRenderer)
├── bash.ts    (getBashCommand,    ├── bash.ts    (BashToolBlock +
│               getBashOutput)     │               bashRenderer)
├── write.ts   (getWriteSummary)   ├── write.ts   (WriteToolBlock +
├── create-task.ts                 │               writeRenderer)
├── delegate.ts                    ├── create-task.ts
├── generic.ts (getToolSummary)    ├── delegate.ts
├── bash-command-parser.ts         ├── generic.ts
└── types.ts   (ToolResultImage)   ├── index.ts   (registry)
                                   └── types.ts   (ToolRenderer)
```

### ToolRenderer Interface

Every renderer implements a single method:

```ts
interface ToolRenderer {
  render(block: ToolBlockData): TemplateResult;
}
```

The renderer receives the full `ToolBlockData` (including `status`) and decides how to present running vs done states internally — typically by computing a `showSpinner` flag and conditionally extracting result data. This ensures the same Lit component instance persists across the running→done transition, preserving local state like expand/collapse.

Renderers own the **entire visual surface** for a tool block — layout, chrome, expand/collapse behavior (including expansion state), syntax highlighting. The chat panel is not involved in tool expansion state. This avoids locking all tools into one interaction pattern.

### Registry & Dispatch

`components/tools/index.ts` maps tool names to renderers with a generic fallback:

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

`components/chat-panel.ts` dispatches in ~3 lines:

```ts
private renderToolBlock(block: ToolBlockData) {
  const renderer = getToolRenderer(block.name);
  return html`<div class="max-w-[90%]">${renderer.render(block)}</div>`;
}
```

## Rendering Pattern

Each tool follows a single-file-per-side pattern:

1. **`models/tools/<name>.ts`** — Pure helper functions that extract data from `ToolBlockData`. No Lit imports.
2. **`components/tools/<name>.ts`** — A `LitElement` custom element that receives primitive props + a `ToolRenderer` object that bridges the two by extracting data via helpers and passing primitives to the component.

The renderer and component live in the same file since the renderer is thin glue (~15 lines):

```ts
// components/tools/read.ts (simplified)

// The component — receives primitives, owns all rendering
@customElement("read-tool-block")
export class ReadToolBlock extends LitElement {
  @property() path = "";
  @property() content = "";
  @property() preview = "";
  @property({ type: Boolean }) showSpinner = false;
  // ... render()
}

// The renderer — extracts data from ToolBlockData, passes to component
export const readRenderer: ToolRenderer = {
  render(block) {
    const isRunning = block.status === "running";
    const path = getReadSummary(block);       // from models/tools/read
    const content = isRunning ? "" : getReadContent(block);
    const preview = isRunning ? "" : getReadPreview(block, PREVIEW_LINES);
    return html`<read-tool-block
      .path=${path} .content=${content} .preview=${preview}
      .showSpinner=${isRunning}
    ></read-tool-block>`;
  },
};
```

This gives a clean one-way data flow:

```
ToolBlockData → renderer (extracts via models/tools/) → component (renders)
```

Components are pure presentational — they have no knowledge of `ToolBlockData` and receive only strings, numbers, booleans, and simple typed arrays.

Each tool block component manages its own `@state() expanded` property — the chat panel has no knowledge of tool expansion state. Because the renderer always produces the same component tag regardless of status, the Lit component instance is reused across the running→done transition and expansion state is preserved.

## Visual Tiers

Tool blocks use three visual tiers based on their role:

| Tier | Tools | Style | Purpose |
|------|-------|-------|---------|
| **File/system** | read, bash, edit, write | `rounded-lg bg-zinc-950 border` card | Most common tools, operate on files/directories |
| **App** | create_task, delegate | `rounded-lg border bg-zinc-950/80` accent card (emerald/purple) | REINS app operations |
| **Generic fallback** | unknown tools | `border-l-2` left-border line | Minimal fallback for unrecognized tools |

Within each tier, border radius and container patterns are consistent. The tiers are intentionally distinct — app tools use colored accents to visually separate them from file operations.

## Data Flow & Testing

Pure helper functions in `models/tools/` are the primary test surface — tested without any DOM in `__tests__/tool-renderer-<name>.test.ts`:

```
models/tools/read.ts       → getReadSummary(), getReadPreview(), getReadContent(), getReadLineCount()
models/tools/bash.ts       → getBashCommand(), getBashPreview(), getBashOutput(), getBashExitInfo()
models/tools/edit.ts       → getEditSummary(), getEditStats(), getEditDiffLines(), parseDiffString()
models/tools/write.ts      → getWriteSummary(), getWriteInfo(), getWriteContent()
models/tools/create-task.ts → getTaskSummary(), getTaskDetail()
models/tools/delegate.ts   → getDelegateSummary(), getDelegateDetail()
models/tools/generic.ts    → getToolSummary()
```

`ToolResultImage` (`{ data: string; mimeType: string }`) lives in `models/tools/types.ts` as a pure data type. The `ToolRenderer` interface (which depends on Lit's `TemplateResult`) lives in `components/tools/types.ts`.

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

The `read`, `edit`, and `write` tool components use `LazyHighlightController` (see [reactive-controllers.md](reactive-controllers.md)) to defer Shiki syntax highlighting until the element scrolls into view. This prevents old tool calls from triggering expensive highlighting on chat load.

The pattern in each tool component:

```ts
private _hl = new LazyHighlightController(this, () => {
  if (!this.path || this.isError) return null;
  const lines = this.content.split("\n");
  return { path: this.path, hunk: { header: "", lines: buildLines() } };
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

`models/tools/bash-command-parser.ts` tokenizes shell commands for syntax highlighting. It splits on operators (`|`, `&&`, `||`, `;`) with quote awareness, identifies the command word (skipping prefixes like `sudo`, `env`, and env-var assignments), and tags segments as `command`, `args`, or `operator` for color-coding in the terminal block.

## Adding a New Tool Renderer

1. Create `models/tools/<name>.ts` with pure helper functions for extracting data from `ToolBlockData`. No Lit imports.
2. Create `components/tools/<name>.ts` with:
   - A `LitElement` custom element that receives **primitive props only** — no `ToolBlockData` import
   - A `ToolRenderer` object that extracts data via the pure helpers and passes primitives to the component
3. Register in `components/tools/index.ts` — add to the `toolRenderers` map and exports
4. Add tests in `__tests__/tool-renderer-<name>.test.ts` covering the pure helpers
