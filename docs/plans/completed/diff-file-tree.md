# Diff File Tree Sidebar

Add a file tree sidebar to the diff panel (and chat view) showing all changed
files. Clicking a file scrolls to its diff card. The existing stacked-scrollable
diff list is preserved.

## Layout

```
┌──────────┬─────────────────────┬──────────────┐
│ Sessions │  Chat / Diff scroll │  File Tree   │
│ Sidebar  │  (all files)        │  (≥1024px)   │
│          │                     │              │
│          │  ┌───────────────┐  │ 📁 packages/ │
│          │  │ app.ts diff   │  │   📄 app.ts  │
│          │  │ ...           │  │   📄 foo.ts  │
│          │  ├───────────────┤  │ 📄 README    │
│          │  │ foo.ts diff   │  │              │
│          │  │ ...           │  │              │
│          │  └───────────────┘  │              │
└──────────┴─────────────────────┴──────────────┘
```

- **Changes tab:** file tree on the right, stacked diff list on the left.
  Clicking a file scrolls to that file's diff card.
- **Chat tab:** same file tree shown on the right when the viewport is wide
  enough (≥1024px / Tailwind `lg:`), hidden on narrower screens. Clicking a
  file switches to the Changes tab and scrolls to it.

---

## Steps

### 1. Create `<diff-file-tree>` component

- [ ] Create `packages/frontend/src/diff-file-tree.ts`
- [ ] Light DOM Lit component (for Tailwind compat)
- [ ] Props:
  - `files: DiffFile[]` — changed files array
  - `activeFile: string | null` — highlighted file path
- [ ] Internal state:
  - `collapsedDirs: Set<string>` — collapsed directory nodes
- [ ] Build nested tree structure from file paths (split on `/`)
- [ ] Render directories as collapsible nodes with aggregate +/− stats
- [ ] Render file leaf nodes with individual +/− stats
- [ ] Highlight the `activeFile` entry
- [ ] Summary header: "N files, +X −Y"
- [ ] Emit `file-select` CustomEvent (detail = file path) on file click
- [ ] Fixed width (~240px), own `overflow-y-auto` scroll
- [ ] All directories expanded by default

### 2. Update `<diff-panel>` to two-column layout

- [ ] Import `<diff-file-tree>`
- [ ] Add stable `id` attributes to each file diff card (derived from path)
- [ ] Add `activeFile: string | null` state property
- [ ] Add `IntersectionObserver` on file cards within the scroll container
      to track which file is topmost visible → sets `activeFile`
- [ ] Change top-level render to flex row:
  - Left: existing scrollable diff list (`flex-1`)
  - Right: `<diff-file-tree .files=${...} .activeFile=${...}>`
- [ ] Handle `file-select` event: find matching file card, call
      `scrollIntoView({ behavior: 'smooth', block: 'start' })`
- [ ] Keep branch info / context controls in header above both columns

### 3. Show `<diff-file-tree>` in chat tab

- [ ] In `<app-shell>`, import `diff-file-tree`
- [ ] `<diff-file-tree>` fetches its own diff data via `activeProjectId`
      prop (self-contained polling, same as diff-panel)
- [ ] Add the tree as a right sidebar next to `<chat-panel>`, wrapped with
      `hidden lg:block` so it only appears at ≥1024px
- [ ] On `file-select` in the chat view: switch `activeTab` to `"changes"`
      and scroll to the selected file in the diff panel

### 4. Polish & verify

- [ ] Confirm existing features still work: file collapse/expand, markdown
      preview toggle, context line expansion
- [ ] Test responsive behavior: tree hidden on narrow viewports in chat tab,
      always visible in changes tab
- [ ] Verify IntersectionObserver correctly tracks the topmost visible file
      during scroll
- [ ] Verify smooth scroll-to on file click
- [ ] Test with 0 files (tree should show "No changes"), 1 file, many files
- [ ] Test deeply nested paths and flat (root-level) files

---

## Out of scope (follow-ups)

- Keyboard navigation (arrow keys in tree)
- Resizable tree sidebar width
- File type icons by extension
- Search / filter in the tree
