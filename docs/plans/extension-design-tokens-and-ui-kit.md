# Design tokens and a UI kit for extensions

> **Changed since this was written:** extension views are no longer in shadow roots. Reins scopes an extension's stylesheet at install and mounts its views in the light DOM ([ADR-038](../adr/038-added-extensions.md), [extension-loading.md](../dev/extension-loading.md) *Styles*), so the app's styles, and so its components, reach extension views. The parts below about shadow roots, `:host` and registries in shadow roots need revisiting with that in mind.

Status: **planned** — not started.

## Goal

An extension should look like Reins without copying Reins' styles, and keep looking like it when Reins' look changes. It should get Reins' common pieces (buttons, inputs, icons, dialogs, toasts) instead of rebuilding them, in any framework, with nothing of the host leaking into its views and nothing of the extension leaking into the app.

## Where we start

- **Extensions are self-contained** ([ADR-038](../adr/038-added-extensions.md), [extension-loading.md](../dev/extension-loading.md)). They deliver built files; the page provides Lit 3 through an import map (`/dist/vendor/lit/`). Each view of Spoke and of the scaffold mounts in a shadow root of its own, with the extension's CSS (its own Tailwind build, bundled as text) adopted there and its own scoped custom element registry attached.
- **The app has no tokens.** Its components use raw Tailwind classes. The most used, across `packages/frontend/src` (2026-11-07): text `zinc-500` (153), `zinc-400` (92), `zinc-200` (71), `zinc-300` (64), `zinc-100` (52), `red-400` (44), `zinc-600` (25); backgrounds `zinc-700` (43), `zinc-800` (32), `zinc-900` (16), `zinc-950` (9), `blue-600` (11), and alpha forms (`zinc-800/70`, `zinc-950/30`); borders `zinc-700` (39), `zinc-600` (29), `zinc-800` (24), `zinc-800/80`, `blue-500`, `yellow-500`; accents `blue-300/400`, `green-400`, `amber-400/90`; type `text-xs` (175), `text-[10px]` (113), `text-sm` (67), `text-[11px]` (22), `text-base` (19); radii `rounded` (85), `rounded-md` (49), `rounded-lg` (36), `rounded-full` (26).
- **The app's UI kit** is `packages/frontend/src/ui/`: `icons.ts` (38 icon functions returning Lit templates, and `paneIcon`), `dialog.ts`, `confirm-dialog.ts`, `input-dialog.ts`, `popover-menu.ts`, `choice-menu.ts`, `choice-selector.ts`, `action-menu-presenter.ts`, `info-card.ts`, `status-dot.ts`, `toast.ts`, `spring-reorder.ts`, `position.ts`. Built-in extensions import it directly; external ones cannot. The SDK has one host-drawn dialog, `ui.renameSession`.
- **Drift seen already:** Spoke's Tailwind (4.3.5) has another default font stack than the app's (4.1.18), so its stylesheet sets `:host { font-family: inherit }`. Its own palette and sizes are copies of Tailwind's defaults, not of the app's.

## Decisions

1. **Tokens are CSS custom properties on `:root`, named for their role.** CSS custom properties are inherited, so they cross shadow boundaries: `var(--reins-surface)` inside an extension's shadow root is the app's value, live, while the app's stylesheet still does not reach in. A theme change (later a light mode) reaches every extension with no rebuild.
2. **The names are the contract; the values are not.** Token names are part of an SDK version (`@reins/sdk` lists and documents them); their values are the app's to change. Renaming or removing a token is a breaking SDK change; adding one is not.
3. **The app uses the tokens too.** Built-ins and extensions share the seam (extension-architecture.md *Built-ins use the same seams*): the app's components move from raw `zinc-*` classes to the tokens, so a token that the app does not use cannot drift.
4. **Tailwind maps to tokens, not the reverse.** `@reins/sdk` ships a Tailwind theme file (`@reins/sdk/tailwind.css`) that defines Tailwind names as references with `@theme inline` (`--color-surface: var(--reins-surface)`), so an extension's `bg-surface text-muted` compile to `var(--reins-…)` and its CSS carries no palette or fonts of its own. The app uses the same file. An extension that does not use Tailwind uses the variables directly.
5. **An extension's shadow root must not redefine the tokens**, and its theme must not set Tailwind's own variables on `:host` (they would override what is inherited). The SDK's theme file replaces Tailwind's default theme for that reason; the scaffold uses it.
6. **The kit has two kinds of thing:**
   - **What Reins draws itself is an SDK action**, as `ui.renameSession` is: dialogs, toasts and menus rendered by the host, in its DOM, with its look, in any framework, with nothing of the host in the extension's view: `reins.ui.confirm({ title, message, confirmLabel?, destructive? }) → Promise<boolean>`, `reins.ui.prompt({ title, label, value?, placeholder? }) → Promise<string | null>`, `reins.ui.toast(message, { level? })`, later `reins.ui.menu(anchor, items) → Promise<id | null>`.
   - **Components inside an extension's view are a library the page provides**, as Lit is: `@reins/ui`, mapped by the import map to `/dist/vendor/reins-ui/`, built by the vendor build. They are Lit web components, each with its own shadow styles built on the tokens, so they look right in any context and any framework can render them (Svelte, React, plain DOM).
7. **The kit's elements go in the extension's registry, not the page's.** A shadow root with a scoped registry does not fall back to the global one, and the host should not know an extension's elements. `@reins/ui` exports its element classes and `define(registry, { prefix? })`, which the extension calls with its own registry (the scaffold's `src/elements.ts` does it), under the names the kit documents (`reins-button`, `reins-input`, …).
8. **Icons are data, not templates.** The kit exports icons as SVG strings and a `<reins-icon name>` element, so every framework can use them; Lit template helpers can come with them for Lit extensions.
9. **Start small and grow from extensions' needs.** The first kit is what Spoke uses: button (primary, secondary, ghost, danger), text input, select, badge, status dot, card, and the icons it draws. Each further piece needs a second user.

## Token list (first version)

Named for their role; the first values are what the app uses today, so the app does not change appearance when it moves onto them.

| Token | First value | Role |
|---|---|---|
| `--reins-surface` | zinc-900 | the page |
| `--reins-surface-sunken` | zinc-950 | inset areas, code |
| `--reins-surface-raised` | zinc-800 | cards, rows, inputs |
| `--reins-surface-overlay` | zinc-900/95 | dialogs, popovers |
| `--reins-surface-hover` | zinc-800/70 | hovered rows and buttons |
| `--reins-control` | zinc-700 | secondary buttons |
| `--reins-control-hover` | zinc-600 | |
| `--reins-border` | zinc-700 | |
| `--reins-border-subtle` | zinc-800 | dividers |
| `--reins-border-strong` | zinc-600 | inputs |
| `--reins-text` | zinc-100 | |
| `--reins-text-secondary` | zinc-300 | |
| `--reins-text-muted` | zinc-400 | |
| `--reins-text-faint` | zinc-500 | hints, timestamps |
| `--reins-text-disabled` | zinc-600 | |
| `--reins-accent` | blue-600 | primary buttons, selection |
| `--reins-accent-hover` | blue-500 | |
| `--reins-accent-text` | blue-300 | links, accent text |
| `--reins-focus-ring` | blue-500/60 | |
| `--reins-success` | green-400 | |
| `--reins-warning` | amber-400 | |
| `--reins-danger` | red-400 | |
| `--reins-danger-surface` | red-400/10 | error boxes |
| `--reins-font-sans`, `--reins-font-mono` | the app's | |
| `--reins-text-2xs`, `-xs`, `-sm`, `-base`, `-lg` | 10px, 12px, 14px, 16px, 18px | (with line heights) |
| `--reins-radius-sm`, `-md`, `-lg`, `-full` | 4px, 6px, 8px, 9999px | |

Spacing stays Tailwind's scale (`--spacing`), which the theme file sets to the app's. Status colors of activity (running, unread) can join when a second extension shows sessions.

## Slices

1. **Tokens in the app.** `packages/frontend/src/components/tokens.css` defines the variables on `:root`; `@reins/sdk/tailwind.css` maps Tailwind names to them and the app's `app.css` uses it. The app looks the same. Test: every token the SDK lists is defined in `tokens.css`, and every one `tailwind.css` references is listed.
2. **Extensions on the tokens.** The scaffold's and Spoke's `styles.css` import `@reins/sdk/tailwind.css` instead of Tailwind's theme; their classes become role names (`bg-surface-raised`, `text-muted`). The `:host { font-family: inherit }` rule goes. Check in a browser that a changed token value reaches an extension's view with no rebuild.
3. **SDK actions.** `reins.ui.confirm`, `prompt` and `toast` over the app's `confirm-dialog`, `input-dialog` and `toast`, in `sdk-host/ui.ts` (where `renameSession` is); built-ins use them instead of importing `ui/` where they can. Spoke's disconnect asks with `confirm`, its failures use `toast`.
4. **The app's kit on tokens.** `ui/` components move from `zinc-*` classes to the tokens, one component at a time, with the views that use them. Lint can then refuse raw palette classes in `ui/` (a `reins/` rule).
5. **`@reins/ui`.** Button, input, select, badge, status dot, card and `<reins-icon>`, as Lit elements with shadow styles on the tokens, in `packages/ui` (or the SDK package), built by the vendor build into `/dist/vendor/reins-ui/` and mapped in the import map; `define(registry)`. The app's own `ui/` uses them where they fit, so they are exercised. Spoke moves its buttons, inputs and icons onto them.
6. **Docs and versioning.** `building-extensions.md` (*Looking like Reins*), reins-sdk.md (tokens, actions, kit), an ADR for tokens and the kit, and the SDK version bumped with the token names and kit as its contract.

## Not in this plan

- Light mode or user themes (the tokens make them possible).
- Menus and popovers as SDK actions, beyond `confirm`, `prompt` and `toast`.
- Settings contributions drawn by the host (reins-sdk.md *Not built yet*), which would use the same tokens.
- React or other frameworks' bindings for the kit: web components work in them as they are.

## Open questions

1. Do kit components draw in their own shadow root (fully isolated, styled only through tokens and `::part`), or in light DOM inside the extension's shadow root (styled by the extension's classes too)? Shadow roots are the safer default.
2. Does `@reins/ui` live in the SDK package (one version) or a package of its own with its own version?
3. Should `text-[10px]`, used 113 times, become the `2xs` step, or should the app's small text settle on fewer sizes first?
