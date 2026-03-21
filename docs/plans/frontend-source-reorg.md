# Frontend Source Reorganization: models/ vs components/

## Goal

Separate pure logic from Lit components in `packages/frontend/src/` to make business logic independently testable and enforce a clear dependency direction.

**Dependency rule**: `models/` never imports from `components/` or `controllers/`. Everything else can import from `models/`.

## Current State

Logic and Lit components are mixed together:
- `tool-renderers/` has pure helpers (e.g. `getReadSummary`, `parseDiffString`) co-located with `html` template returns in the same file
- `changes/` mixes pure logic (`diff-sort.ts`, `diff-utils.ts`, `file-tree-state.ts`) with Lit components (`diff-panel.ts`, `diff-file-card.ts`)
- `stores/` is already pure logic but lives at the same level as components
- Top-level files are a mix of both

## Proposed Structure

```
src/
├── models/                              # Pure logic — no LitElement, no html``
│   ├── stores/
│   │   ├── app-store.ts
│   │   ├── active-session-store.ts
│   │   ├── diff-store.ts
│   │   ├── project-store.ts
│   │   ├── project-collection-store.ts
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
│   │   ├── read.ts                      # getReadSummary, getReadPreview, etc.
│   │   ├── edit.ts                      # getEditStats, parseDiffString, etc.
│   │   ├── write.ts                     # getWriteSummary, getWriteInfo
│   │   ├── bash.ts                      # (extract pure helpers)
│   │   ├── create-task.ts               # (extract pure helpers)
│   │   └── delegate.ts                  # (extract pure helpers)
│   ├── chat-state.ts
│   ├── format.ts
│   ├── router.ts
│   └── ws-client.ts
│
├── components/                          # Lit components — own rendering + interaction
│   ├── changes/
│   │   ├── diff-panel.ts
│   │   ├── diff-file-card.ts
│   │   ├── diff-file-tree.ts
│   │   ├── diff-hunk.ts
│   │   └── diff-markdown-preview.ts
│   ├── tools/
│   │   ├── read-tool-block.ts
│   │   ├── edit-tool-block.ts
│   │   ├── write-tool-block.ts
│   │   ├── bash-tool-block.ts
│   │   ├── create-task-tool-block.ts
│   │   ├── delegate-tool-block.ts
│   │   ├── generic-tool-block.ts
│   │   ├── base.ts                      # renderCollapsibleTool helper
│   │   ├── registry.ts                  # tool name → renderer mapping
│   │   └── types.ts                     # ToolRenderer interface (with TemplateResult)
│   ├── app.ts
│   ├── chat-panel.ts
│   ├── session-list.ts
│   ├── session-sidebar.ts
│   ├── project-form.ts
│   ├── project-sidebar.ts
│   ├── task-detail.ts
│   ├── task-form.ts
│   ├── task-list.ts
│   ├── branch-indicator.ts
│   ├── quick-open.ts
│   ├── popover-menu.ts
│   └── toast.ts
│
├── controllers/                         # Lit reactive controllers (glue between models + components)
│   ├── store-controller.ts
│   ├── highlight-controller.ts
│   └── lazy-highlight-controller.ts
│
└── index.ts
```

## Key Decisions

- **`controllers/` stays top-level** — they're Lit-aware glue reused across components, neither pure logic nor full components.
- **`stores/` nests under `models/`** — they're already pure logic; this makes the boundary explicit.
- **`changes/` splits** — pure half to `models/changes/`, Lit components to `components/changes/`.
- **`tool-renderers/` splits into `models/tools/` + `components/tools/`** — pure data-extraction helpers separate from rendering.

## Migration Strategy

This is a mechanical refactor — move files, update import paths, verify tests pass. Can be done incrementally:

1. Create `models/` and `components/` directories
2. Move `stores/` under `models/` (already pure, lowest risk)
3. Split `changes/` — move pure files to `models/changes/`, components to `components/changes/`
4. Split `tool-renderers/` — extract pure helpers to `models/tools/`, move components to `components/tools/`
5. Move remaining top-level files to appropriate locations
6. Update all import paths
7. Verify tests pass

Each step can be a separate commit for easy review/revert.
