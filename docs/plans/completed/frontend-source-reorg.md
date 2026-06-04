# Frontend Source Reorganization: models/ vs components/

## Goal

Separate pure logic from Lit components in `packages/frontend/src/` to make business logic independently testable and enforce a clear dependency direction.

**Dependency rule**: `models/` never imports from `components/` or `controllers/`. Everything else can import from `models/`.

## Current State (as of 2026-03-21)

```
src/
├── __tests__/                           # All test files (flat)
│   ├── app-store-activity.test.ts
│   ├── app-store-reconnect.test.ts
│   ├── bash-command-parser.test.ts
│   ├── chat-panel-dedup.test.ts
│   ├── diff-file-card-collapse.test.ts
│   ├── diff-file-card-markdown.test.ts
│   ├── diff-highlight-notify.test.ts
│   ├── diff-sort.test.ts
│   ├── diff-store.test.ts
│   ├── diff-utils.test.ts
│   ├── file-tree-state.test.ts
│   ├── highlight-controller.test.ts
│   ├── lazy-highlight-controller.test.ts
│   ├── project-collection-store.test.ts
│   ├── project-store.test.ts
│   ├── quick-open-store.test.ts
│   ├── store-controller.test.ts
│   ├── tool-renderer-bash.test.ts
│   ├── tool-renderer-create-task.test.ts
│   ├── tool-renderer-delegate.test.ts
│   ├── tool-renderer-edit.test.ts
│   ├── tool-renderer-read.test.ts
│   ├── tool-renderer-registry.test.ts
│   ├── tool-renderer-write.test.ts
│   └── ws-client-events.test.ts
├── changes/
│   ├── diff-file-card.ts                # Lit component
│   ├── diff-file-tree.ts                # Lit component
│   ├── diff-hunk.ts                     # Lit component
│   ├── diff-markdown-preview.ts         # Lit component
│   ├── diff-panel.ts                    # Lit component
│   ├── diff-sort.ts                     # Pure logic
│   ├── diff-utils.ts                    # Pure logic
│   ├── file-tree-state.ts              # Pure logic
│   ├── highlight-worker.ts             # Pure logic (Web Worker)
│   ├── highlighter.ts                  # Pure logic (interface + impl)
│   ├── scroll-spy.ts                   # Pure logic
│   └── types.ts                        # Pure types
├── controllers/
│   ├── highlight-controller.ts
│   ├── lazy-highlight-controller.ts
│   └── store-controller.ts
├── stores/
│   ├── active-session-store.ts
│   ├── app-store.ts
│   ├── diff-store.ts
│   ├── project-collection-store.ts
│   ├── project-store.ts
│   └── quick-open-store.ts
├── tool-renderers/
│   ├── bash-command-parser.ts           # Pure logic (shell parser)
│   ├── bash-tool-block.ts              # Lit component
│   ├── bash.ts                         # Mixed: pure helpers + renderer (html``)
│   ├── create-task-tool-block.ts       # Lit component
│   ├── create-task.ts                  # Mixed: pure helpers + renderer
│   ├── delegate-tool-block.ts          # Lit component
│   ├── delegate.ts                     # Mixed: pure helpers + renderer
│   ├── edit-tool-block.ts              # Lit component
│   ├── edit.ts                         # Mixed: pure helpers + renderer
│   ├── generic-tool-block.ts           # Lit component
│   ├── generic.ts                      # Mixed: pure getToolSummary + genericRenderer
│   ├── index.ts                        # Registry (getToolRenderer)
│   ├── read-tool-block.ts              # Lit component
│   ├── read.ts                         # Mixed: pure helpers + renderer
│   ├── types.ts                        # ToolRenderer interface
│   ├── write-tool-block.ts             # Lit component
│   └── write.ts                        # Mixed: pure helpers + renderer
├── app.css                             # App shell styles
├── app.ts                              # Lit component
├── branch-indicator.ts                 # Lit component
├── chat-panel.ts                       # Lit component
├── chat-state.ts                       # Pure logic
├── format.ts                           # Pure logic
├── index.ts                            # Entry point
├── popover-menu.ts                     # Lit component
├── project-form.ts                     # Lit component
├── project-sidebar.ts                  # Lit component
├── quick-open.ts                       # Lit component
├── router.ts                           # Pure logic
├── session-list.ts                     # Lit component
├── session-sidebar.ts                  # Lit component
├── task-detail.ts                      # Lit component
├── task-form.ts                        # Lit component
├── task-list.ts                        # Lit component
├── toast.ts                            # Lit component
└── ws-client.ts                        # Pure logic
```

## Proposed Structure

```
src/
├── models/                              # Pure logic — no LitElement, no html``
│   ├── stores/
│   │   ├── active-session-store.ts
│   │   ├── app-store.ts
│   │   ├── diff-store.ts
│   │   ├── project-collection-store.ts
│   │   ├── project-store.ts
│   │   └── quick-open-store.ts
│   ├── changes/
│   │   ├── diff-sort.ts
│   │   ├── diff-utils.ts
│   │   ├── file-tree-state.ts
│   │   ├── scroll-spy.ts
│   │   ├── highlighter.ts
│   │   ├── highlight-worker.ts
│   │   └── types.ts
│   ├── tools/
│   │   ├── bash-command-parser.ts       # Shell command parser (from tool-renderers/)
│   │   ├── bash.ts                      # getBashCommand, getBashPreview, etc.
│   │   ├── create-task.ts               # getTaskSummary, getTaskDetail, etc.
│   │   ├── delegate.ts                  # getDelegateSummary, getDelegateDetail
│   │   ├── edit.ts                      # getEditStats, parseDiffString, etc.
│   │   ├── generic.ts                   # getToolSummary
│   │   ├── read.ts                      # getReadSummary, getReadPreview, etc.
│   │   └── write.ts                     # getWriteSummary, getWriteInfo, etc.
│   ├── chat-state.ts
│   ├── format.ts
│   ├── router.ts
│   └── ws-client.ts
│
├── components/                          # Lit components — own rendering + interaction
│   ├── changes/
│   │   ├── diff-file-card.ts
│   │   ├── diff-file-tree.ts
│   │   ├── diff-hunk.ts
│   │   ├── diff-markdown-preview.ts
│   │   └── diff-panel.ts
│   ├── tools/
│   │   ├── bash.ts                      # BashToolBlock component + bashRenderer
│   │   ├── create-task.ts               # CreateTaskToolBlock + createTaskRenderer
│   │   ├── delegate.ts                  # DelegateToolBlock + delegateRenderer
│   │   ├── edit.ts                      # EditToolBlock + editRenderer
│   │   ├── generic.ts                   # GenericToolBlock + genericRenderer
│   │   ├── index.ts                     # Registry (getToolRenderer)
│   │   ├── read.ts                      # ReadToolBlock + readRenderer
│   │   ├── types.ts                     # ToolRenderer interface
│   │   └── write.ts                     # WriteToolBlock + writeRenderer
│   ├── app.css
│   ├── app.ts
│   ├── branch-indicator.ts
│   ├── chat-panel.ts
│   ├── popover-menu.ts
│   ├── project-form.ts
│   ├── project-sidebar.ts
│   ├── quick-open.ts
│   ├── session-list.ts
│   ├── session-sidebar.ts
│   ├── task-detail.ts
│   ├── task-form.ts
│   ├── task-list.ts
│   └── toast.ts
│
├── controllers/                         # Lit reactive controllers (glue between models + components)
│   ├── highlight-controller.ts
│   ├── lazy-highlight-controller.ts
│   └── store-controller.ts
│
├── __tests__/                           # Tests stay flat — only import paths change
│
└── index.ts
```

## Key Decisions

- **`controllers/` stays top-level** — they're Lit-aware glue reused across components, neither pure logic nor full components.
- **`stores/` nests under `models/`** — they're already pure logic; this makes the boundary explicit.
- **`changes/` splits** — pure half to `models/changes/`, Lit components to `components/changes/`.
- **`tool-renderers/` splits into `models/tools/` + `components/tools/`** — each mixed file (e.g. `read.ts`) gets split: pure data-extraction helpers move to `models/tools/read.ts`, the renderer object (which uses `html``) gets merged into the corresponding `-tool-block.ts` component file (e.g. `readRenderer` merges into `read-tool-block.ts`). No need for separate renderer glue files — they're only ~15 lines each.
- **`bash-command-parser.ts`** moves to `models/tools/` as-is (already pure).
- **`index.ts` (registry)** moves to `components/tools/index.ts` — it maps tool names to renderers without re-exporting renderers.
- **`types.ts`** (ToolRenderer) moves to `components/tools/types.ts` — `ToolRenderer` depends on Lit's `TemplateResult`; tool result images use the canonical `ChatImageBlock` type.
- **`app.css`** moves with `app.ts` to `components/`.
- **`__tests__/` stays flat** — test files don't move, only their import paths update.

## Migration Strategy

Mechanical refactor — move files, update import paths, verify tests pass. Each step is a separate commit.

### Step 1: Create directories and move `stores/` → `models/stores/`

Already pure logic, lowest risk. Move the directory and update all imports.

**Files moved:**
- `stores/*` → `models/stores/*`

**Imports to update:**
- All files importing from `../stores/` or `./stores/` — adjust to `../models/stores/` etc.
- Test files importing from `../stores/` → `../models/stores/`

### Step 2: Split `changes/` — pure files to `models/changes/`, components to `components/changes/`

**To `models/changes/`:** diff-sort.ts, diff-utils.ts, file-tree-state.ts, scroll-spy.ts, highlighter.ts, highlight-worker.ts, types.ts

**To `components/changes/`:** diff-panel.ts, diff-file-card.ts, diff-file-tree.ts, diff-hunk.ts, diff-markdown-preview.ts

**Imports to update:**
- Components in `components/changes/` import pure logic from `../../models/changes/`
- Test files importing from `../changes/` — update to `../models/changes/` (pure) or `../components/changes/` (components)
- Controllers importing from `../changes/` → `../models/changes/`

### Step 3: Split `tool-renderers/` — pure helpers to `models/tools/`, renderers + components to `components/tools/`

Each mixed renderer file (read.ts, bash.ts, edit.ts, write.ts, create-task.ts, delegate.ts, generic.ts) gets split:
- **Pure exported functions** → `models/tools/<name>.ts`
- **Renderer object** (~15 lines of `html`` glue) → **merged into** the corresponding component file. The separate renderer files are deleted.

**Renamed:** `*-tool-block.ts` → `<name>.ts` — the `-tool-block` suffix only existed to disambiguate from the helper files in the same directory. Now that components and models live in separate trees, both sides can just be `read.ts`, `write.ts`, etc. Class names (`ReadToolBlock`) and custom element tags (`<read-tool-block>`) stay unchanged.

**Moved as-is:**
- `bash-command-parser.ts` → `models/tools/bash-command-parser.ts` (already pure)
- `*-tool-block.ts` → `components/tools/<name>.ts` (renamed, with renderer merged in)
- `index.ts` → `components/tools/index.ts` (registry, updated imports)
- `types.ts` → `components/tools/types.ts`

**Deleted after merge:**
- `tool-renderers/read.ts`, `bash.ts`, `edit.ts`, `write.ts`, `create-task.ts`, `delegate.ts`, `generic.ts` — pure helpers extracted to models, renderer merged into component.

**Imports to update:**
- Test files importing pure helpers from `../tool-renderers/<name>.js` → `../models/tools/<name>.js`
- Test files importing renderers from `../tool-renderers/<name>.js` → `../components/tools/<name>.js`
- `chat-panel.ts` importing from `./tool-renderers/` → `./tools/` (will be sibling under components/)
- Component tool files importing `../chat-state.js` → `../../models/chat-state.js`
- Component tool files importing `../changes/types.js` → `../../models/changes/types.js`
- Component tool files importing `./bash-command-parser.js` → `../../models/tools/bash-command-parser.js`
- Registry `index.ts` imports updated: `./read-tool-block.js` → `./read.js`, etc.

### Step 4: Move remaining top-level files

**To `models/`:** chat-state.ts, format.ts, router.ts, ws-client.ts

**To `components/`:** app.ts, app.css, chat-panel.ts, session-sidebar.ts, session-list.ts, project-sidebar.ts, project-form.ts, task-detail.ts, task-form.ts, task-list.ts, branch-indicator.ts, quick-open.ts, popover-menu.ts, toast.ts

**Imports to update:** Everything — this is the biggest step. All cross-references between models ↔ components need the new paths. Do components first (they mostly import from models), then models (they only import from each other).

### Step 5: Update `index.ts` entry point

- `index.ts` stays at `src/index.ts`
- Update: `import "./app.js"` → `import "./components/app.js"`

### Step 6: Final verification

- Run `bun test` — all tests pass
- Run `bun run build` (if applicable) — build succeeds
- Grep for any remaining old import paths (`tool-renderers/`, `stores/`, `changes/` at wrong depth)
- Verify dependency rule: `grep -r "from.*components" models/` returns nothing
