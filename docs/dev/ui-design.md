# UI Design

CSS architecture, visual conventions, and design tokens for the frontend. For component structure and data flow, see [frontend-architecture.md](frontend-architecture.md).

## Tailwind CSS v4

The frontend uses Tailwind CSS v4 with the `@import "tailwindcss"` directive. All custom CSS lives in `components/app.css`, which is the single global stylesheet. Components use Tailwind utility classes inline via template literals — there are no component-scoped stylesheets or shadow DOM.

## CSS custom properties

Global design tokens are defined as CSS custom properties on `:root` in `app.css`.

### Z-index layers

Overlapping UI elements use a shared z-index system rather than magic numbers. Components reference these via Tailwind's arbitrary value syntax: `z-[var(--layer-overlay)]`.

```css
--layer-content: 10;   /* sticky headers, in-page floating elements */
--layer-sidebar: 40;   /* mobile sidebar backdrop */
--layer-overlay: 50;   /* modal overlays (file viewer, delete dialog, popovers) */
--layer-palette: 60;   /* command palettes (quick-open, file search) */
--layer-toast: 70;     /* toast notifications — always on top */
```

```
  toast      ─── 70  (always visible, e.g. copy confirmations)
  palette    ─── 60  (quick-open, file search)
  overlay    ─── 50  (file browser, delete dialog, popovers)
  sidebar    ─── 40  (mobile sidebar backdrop)
  content    ─── 10  (sticky diff card headers, etc.)
```

The key design constraint is that **palettes render above overlays**. This lets the user open the file search palette (`Cmd+P`, palette layer) on top of the file viewer (overlay layer) to switch files without closing the viewer.

When adding new overlapping UI, pick the appropriate layer variable. If a new layer is genuinely needed, add it to `app.css` with a comment and update this table.

### Safe area / keyboard handling

```css
--input-bottom: calc(0.75rem + env(safe-area-inset-bottom));
```

Used by the chat input for bottom padding that respects device safe areas (notch, home indicator). When the virtual keyboard opens, `app.ts` adds a `.keyboard-open` class to `:root`, which collapses the safe-area inset to a plain `0.75rem` — preventing a gap between the keyboard and the input.

## Color palette

The app uses a dark theme built on Tailwind's `zinc` scale. There are no light/dark mode toggles — it's dark-only.

Common patterns:
- **Backgrounds**: `bg-zinc-900` (main), `bg-zinc-800` (cards, headers), `bg-zinc-950` (code blocks)
- **Text**: `text-zinc-200` (primary), `text-zinc-400` (secondary/muted), `text-zinc-500`/`text-zinc-600` (subtle)
- **Borders**: `border-zinc-700` (standard), `border-zinc-600` (emphasized)
- **Hover states**: one step lighter (e.g. `bg-zinc-800` → `hover:bg-zinc-750`)

## Diff line colors

Diff additions and removals use translucent backgrounds so syntax highlighting shows through:

```css
.diff-add    { @apply bg-green-900/30 text-zinc-200; }
.diff-remove { @apply bg-red-900/30 text-zinc-200; }
```

## Syntax highlighting

Two highlighting systems coexist:

All syntax highlighting uses **Shiki** via a shared Web Worker (`highlight-worker.ts`). Diff hunks use `HighlightController` (see [reactive-controllers.md](reactive-controllers.md)), and markdown code blocks use `shared-highlighter.ts`. Shiki produces pre-styled HTML spans with inline styles — no external CSS classes needed.

> **Dead code**: `app.css` still contains ~80 lines of `.hljs-*` token color rules from a previous highlight.js integration. These are unused — tracked in [tech-debt.md](../tech-debt.md) for removal.

## Markdown prose

The `.prose` class in `app.css` provides dark-themed overrides for rendered markdown (chat messages, markdown previews). Covers headings, code blocks, links, tables, lists, blockquotes, and horizontal rules — all styled against the zinc dark background.

## Utility classes

### `.direction-rtl`

Left-truncates file paths by using RTL direction, making the ellipsis appear on the left so the filename (rightmost segment) stays visible:

```css
.direction-rtl {
  direction: rtl;
  text-align: left;
  unicode-bidi: plaintext;
}
```

## Scrollbar styling

Custom WebKit scrollbar styles: 8px wide, transparent track, `zinc-700` thumb with `zinc-600` on hover. Rounded with `rounded-full`.

## Responsive patterns

- **Mobile sidebar**: hidden by default, slides in as a fixed overlay at `--layer-sidebar` / `--layer-overlay` z-indices. Backdrop at `--layer-sidebar`.
- **File viewer**: full-screen (`100vw × 100dvh`, no rounded corners) on mobile, centered `90vw × 90vh` with rounded corners on desktop (`sm:` breakpoint).
- **Diff file tree**: sidebar only visible on wide screens, hidden on narrow viewports.
- **Textarea**: uses `field-sizing: content` for auto-resize, capped at `max-height: 200px`.
