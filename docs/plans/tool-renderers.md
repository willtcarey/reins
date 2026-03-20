# Tool-Specific Inline Renderers

## Goal

Replace the generic expand-to-see-JSON tool call display in `chat-panel.ts` with tool-specific compact renderings. Each tool gets its own renderer that owns the full rendering surface.

## Architecture ✅

### ToolRenderer Interface ✅

```ts
interface ToolRenderer {
  renderRunning(block: ToolBlockData): TemplateResult;
  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void): TemplateResult;
}
```

Renderers own the **entire visual output** for a tool block — layout, chrome, expand/collapse behavior (if any). This avoids locking all tools into one interaction pattern.

### Base Helpers ✅

Utility functions that renderers can opt into (not a forced wrapper):

```ts
/** Standard collapsible tool block with left border + expand/collapse */
function renderCollapsibleTool(opts: {
  block: ToolBlockData;
  expanded: boolean;
  onToggle: () => void;
  summary: TemplateResult | string;
  detail?: TemplateResult;
  borderColor?: string;        // default: 'border-zinc-600'
  isError?: boolean;
}): TemplateResult;

/** Standard running indicator with spinner */
function renderRunningTool(opts: {
  name: string;
  summary: TemplateResult | string;
  borderColor?: string;        // default: 'border-yellow-500'
}): TemplateResult;
```

Most renderers will use these helpers with custom summary/detail content. Renderers like `edit` (inline diff) or `bash` (terminal-style) can bypass them entirely.

### Registry ✅

Simple static map with generic fallback:

```ts
// tool-renderers/index.ts
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

### File Layout ✅

```
src/
  tool-renderers/
    index.ts              # registry, ToolRenderer type, getToolRenderer()
    base.ts               # renderCollapsibleTool, renderRunningTool helpers
    generic.ts            # current JSON-dump behavior (fallback)
    read.ts
    bash.ts
    edit.ts
    write.ts
    create-task.ts
    delegate.ts
```

### chat-panel.ts Changes ✅

`renderToolBlock()` and `renderToolCall()` become thin dispatchers:

```ts
private renderToolBlock(block: ToolBlockData) {
  const renderer = getToolRenderer(block.name);
  if (block.status === "running") {
    return renderer.renderRunning(block);
  }
  const expanded = this.expandedTools.has(block.id);
  return renderer.renderDone(block, expanded, () => this.toggleTool(block.id));
}
```

`toolSummary()` is removed — each renderer handles its own summary.

## Per-Tool Rendering

### read ✅
- **Collapsed**: file icon + path, truncated content preview (first ~2 lines of result)
- **Expanded**: scrollable content preview (already truncated to 5KB in result)
- Uses base collapsible helper

### bash ✅ (needs refinement)
- Terminal-style dark block (`bg-zinc-950`), command always visible with green `$` prompt
- Tapping expands to reveal output below a divider
- Spinner while running, red border + error badge on failure
- Owns full rendering surface (no base collapsible helper)
- **TODO**: Command display needs work — showing the full command is nice but can be visually overwhelming in the chat flow, especially for long multi-line commands. Consider truncating/collapsing long commands, or visually de-emphasizing them so the eye isn't drawn to every tool block equally.

### edit ✅
- **Collapsed**: card-style block (bg-zinc-950 rounded border) with file path + stats badge (+3 −1), matching read-tool-block style
- **Expanded**: inline diff with context lines (green/red bg), line numbers, and ellipsis separators
- Uses server-computed unified diff from `details.diff` when available, falls back to naive oldText→newText diff
- Owns full rendering surface for custom diff layout

### write ✅
- **Collapsed**: card-style block (matching edit-tool-block) with file path + line count badge
- **Expanded**: syntax-highlighted content preview, all lines shown as additions (green)
- Owns full rendering surface via `<write-tool-block>` custom element with lazy syntax highlighting

### create_task ✅
- **Collapsed**: task title, branch name
- **Expanded**: description
- Uses base collapsible helper

### delegate ✅
- **Collapsed**: truncated prompt summary
- **Expanded**: full prompt + result summary
- Uses base collapsible helper

### generic (fallback) ✅
- Current behavior: JSON args + raw result text
- Uses base collapsible helper

## Edit Tool: Inline Diff Details ✅

The `edit` renderer uses server-computed diffs when available:

1. The pi SDK's edit tool returns `details: { diff: string, firstChangedLine?: number }` in its `ToolResult`
2. `details` is plumbed through: `tool_execution_end` event → `StreamingToolBlock.result.details` / `ToolResultMessage.details` → `ToolBlockData`
3. `parseDiffString()` parses the pi diff format (`+lineNum text`, `-lineNum text`, ` lineNum text`, ellipsis) into `DiffLine[]`
4. `getEditDiffLines()` prefers `details.diff`, falling back to the naive `computeEditDiff()` (all old as remove, all new as add)
5. `getEditStats()` also prefers the parsed diff for accurate +/- counts

## Migration ✅

1. ✅ Extract base helpers and generic renderer from current `renderToolBlock()`
2. ✅ Wire up registry + dispatcher in `chat-panel.ts`
3. ✅ Implement tool-specific renderers one at a time
4. ✅ Remove `toolSummary()` once all tools have renderers

## Remaining Work

- ✅ **Edit: auto-expand small diffs** — Diffs ≤20 lines are shown inline by default; user can still click to collapse (tracked via internal `_manuallyCollapsed` flag in `EditToolBlock`)
- **Bash: command display refinement** — Full commands can be visually overwhelming; explore truncation, collapsing, or de-emphasis for long commands
- **Read: remove word wrapping** — Content lines use `whitespace-pre-wrap` / `break-words` which wraps long lines. Should use horizontal scroll (`whitespace-pre`, `overflow-x-auto`) to match the changes tab diff viewer.
- **Split test file** — `tool-renderers.test.ts` is a single file covering all renderers. Split into per-renderer test files (e.g., `tool-renderer-bash.test.ts`, `tool-renderer-edit.test.ts`, etc.) with a separate file for the registry
