# Design tokens and a UI kit for extensions

> **Changed since this was first written:** extension views are no longer in shadow roots. Reins scopes an extension's stylesheet at install and mounts its views in the light DOM ([ADR-038](../adr/038-added-extensions.md), [extension-loading.md](../dev/extension-loading.md) *Styles*), so the app's styles, and so its components, reach extension views. The parts below about shadow roots, `:host` and registries in shadow roots need revisiting with that in mind.

Status: **in progress**: slice 1 (`@reins/ui` with the sidebar row and badge) is done (2026-11-15, task #431; *Slice 1: decisions* below); slice 2 (tokens) has started: the kit reads them; the app's `<reins-markdown>` is done (2026-11-16, *The Markdown element: decisions* below). The current look is the contract: the user will adjust values over time, which tokens and the kit then carry to every extension.

## Three layers (decided 2026-11-15)

Consistency comes from three layers, strongest first. Use the strongest one that fits.

1. **Reins draws it from data**, where the shape is fixed and Reins owns the interaction: Launcher items, and later `confirm`, `prompt`, `toast`, menus. The extension gives data; it cannot drift because it does not draw.
2. **Kit components that the page provides** (`@reins/ui`), for what an extension draws itself inside its own mounts: a sidebar row, a badge, and later a pane, a section, a list row, an empty state, buttons, inputs. The extension keeps its mount and its framework; the component is Reins' current code at run time, so a change to Reins' look reaches every extension with no rebuild. Reins does not take over the rendering of sidebar sections or views: `registerSection({ mount })` and views' `mount` stay the base, and the kit is used inside them.
3. **Tokens and the Tailwind theme file** underneath, for anything custom (the token list below).

Why the kit is page-provided and not a package extensions bundle: a bundled helper freezes the look at the extension's build, so two extensions built at different times differ again (Spoke's and Inbox's sidebar rows were copied from each other and already differed: one has icons in its count chips, the other does not, with other colors).

**Slices, in order:** (1) ✅ `@reins/ui` with `<reins-sidebar-row>` and `<reins-badge>`, used by the built-in sidebar sections where they fit, Spoke and Inbox; (2) tokens and the theme file (the old slices 1–2 below); (3) more kit components, pattern components first (pane, section, list row, empty state), with a gallery page; (4) the SDK actions (`confirm`, `prompt`, `toast`). The old *Slices* section below is kept for its detail; where it and this section disagree, this section wins.

## Slice 1: decisions (2026-11-15)

Built: `packages/ui` (`@reins/ui`) with `<reins-sidebar-row>` and `<reins-badge>`, mapped by the import map to `/dist/vendor/reins-ui/index.js` and built by the vendor build on the provided Lit; Spoke and Inbox draw their sidebar rows with it. How it works in detail: [extension-loading.md](../dev/extension-loading.md) *Provided libraries*; for authors: [building-extensions.md](../features/building-extensions.md) *Looking like Reins*.

- **Any framework, and no Lit in the extension** (the user's requirement). Importing `@reins/ui` defines the elements in the page's global registry, with names the kit owns (`reins-…`); Svelte, React and plain DOM create them there. Every property has an attribute. The kit is Lit inside, on the page's Lit, and that stays inside it.
- **Scoped registries: optional `define(registry)`.** A Lit extension using `@reins/sdk/lit` creates its templates' elements through its own registry, which does not see the global one, so it calls `define(registry)` (`@reins/sdk/lit` now exports `registry`). Each scoped registry gets subclasses, as one registry may refuse a constructor another has. Checked by the user in a browser with scoped registries (Inbox's row), and in Chrome 145, which takes the global path.
- **Light DOM, which answers open question 1** (the user's choice, 2026-11-15, over shadow roots with `::part`). An extension may change a kit element's look, and when it does, it means to. The elements draw in the light DOM, and their rules (`packages/ui/src/kit.css`) are page rules that `app.css` imports in its `components` layer, under the app's utilities and extensions' own rules. The cost, accepted: an extension rule that matches the kit's parts by accident (`.reins-sidebar-row-label`, or a broad `button { … }`) changes them too. The kit's class names carry the element's name to make that unlikely. A shadow-root version came first in this slice and was replaced the same day.
- **Its own package, which answers open question 2.** `packages/ui` and not the SDK package: the import specifier is the package's name, so TypeScript, Bun and editors resolve `@reins/ui` with no ambient declarations or path mappings, and the kit's tests import it as an extension would. Its types are a contract file, `ui.d.ts`, with plain DOM interfaces (no Lit types, so a Svelte extension installs no Lit), checked against the implementation by `src/contract.ts`. Its version follows the SDK's; the manifest's `sdk` range covers it. Lit and happy-dom are the Reins root's dev dependencies, as Bun installs a `file:` dependency's dev dependencies in the extension too.
- **The icon is an SVG string** (attribute `icon`): data any framework can give, and the kit sizes it and colors it (`currentColor`). **The press is a `click` on the row** (its button holds the icon and label; its badges follow it), not an `href` or an event of the kit's. Svelte's a11y check does not know the button the element draws: Spoke silences it on that line, and the guide shows that.
- **The badge hides itself** at 0 or no value (`display: none` by attribute, so it takes no gap either); `value` and `tone` reflect to attributes for that.
- **The look:** Spoke's and Inbox's row and chips, where they agree (row: `rounded-md px-2 py-1.5 text-sm`, `zinc-300`, hover `zinc-800/60`, current `zinc-800`/`zinc-100`; chip: `h-4 min-w-5 rounded-full px-1 text-[10px] font-semibold`, `<color>-500/15` on `<color>-300`); the `attention` tone is Inbox's amber, and `neutral` follows the same rule in zinc. New: a focus ring (`blue-500/70`, as `info-card`'s), where the extensions had the browser's.
- **The kit reads tokens, never values** (2026-11-15, after slice 1, at the user's request: the tokens are where a theme changes Reins' look, everywhere). `packages/frontend/src/components/tokens.css` (imported by `app.css`) defines on `:root` the tokens the kit uses, with today's values: `--reins-text`, `-text-secondary`, `-text-muted`, `--reins-surface-raised`, `-surface-hover`, `--reins-accent-text`, `--reins-focus-ring`, `--reins-tone-{attention,info,neutral}` and their `-surface`, `--reins-text-2xs`, `-text-sm` (with `-text-sm-line-height`), `--reins-radius-md`. The kit's CSS (`kit.css`) is only which token goes where; its two timings are tokens too (`--reins-duration-fast`, `--reins-ease`). Checked in a browser: setting a token on `:root` changes the kit's rows and badges in Spoke at once. Hover is the app's `zinc-800/70` (Spoke and Inbox had `/60`). The badge tones are new role tokens, added to the list below. The app's own components do not read the tokens yet: that is the rest of slice 2.
- **The kit uses Tailwind classes on the tokens** (2026-11-15, the user's choice). `packages/frontend/src/components/theme.css` gives the tokens Tailwind names with `@theme inline` (the start of decision 4's theme file; it moves into `@reins/sdk/tailwind.css` for extensions with the rest of slice 2), and Tailwind's own `text-sm`, `rounded-md` and default transition now read their tokens, with the same values. The kit's templates style their inner parts with those classes, which the app's build generates (`@source` on `packages/ui/src`). `kit.css` keeps only the rules for the elements themselves and their attribute states, as the element is the box (a row holds the badges a framework put in it) and the kit must not set classes on its elements (their `class` attribute is the writer's); those rules use the same classes through `@apply` (the user's choice), so the kit has one vocabulary and sets no values, and `kit.css` works only in the app's Tailwind build. `--reins-radius-full` went: Tailwind's `rounded-full` is not a theme value. So later kit components are mostly classes, with a few element rules each.
- **No built-in uses it yet** (the user's choice): no built-in sidebar part has the row's shape, and the delegate count's chip (9px, with a hover tint) stays as it is.

## The Markdown element: decisions (2026-11-16)

Built: `<reins-markdown>` (attribute and property `text`), for the Inbox extension's item texts and Spoke's issue text. How it works: [extension-loading.md](../dev/extension-loading.md) *Provided libraries*.

- **The app provides it, not the kit** (the user's requirement): nothing of the Markdown code (`marked`, Shiki, Mermaid) is bundled in extensions or in `@reins/ui`. The app defines it in the global registry at startup from the chat's own renderer, factored out of `markdown-content` into `components/markdown-rendering.ts`, so it always looks like the chat. It is a second kind of page-provided component: the app's code, where the kit's elements are the kit's.
- **Scoped registries through the kit's `define(registry)`**, which subclasses the class it reads from the global registry. The global registry is what the page already exposes, so there is no new global; extensions call the one `define` they already call.
- **Its contract is in `ui.d.ts`**, beside the kit's elements, not in the SDK: the tag-name map and `define` are there, and an extension that uses the kit's elements needs no second types package. The app's class `implements` it.
- **Raw HTML is removed, not sanitized to an allow-list**, and links and images are kept only with safe URLs; external links open in a new tab. No trusted opt-in. The reasons are in extension-loading.md.
- **The file viewer uses it** (the user's choice, 2026-11-16): a repository's Markdown is outside text, and with the chat's renderer a README's raw HTML ran script in the app's page. READMEs' HTML (centered logos, `<details>`, badge rows) no longer shows in the preview, and its images open no viewer. The chat stays on `<markdown-content>`.

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
| `--reins-surface-hover` | zinc-800/70 | hovered rows and buttons (defined) |
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
| `--reins-focus-ring` | blue-500/70 | (`info-card`'s) |
| `--reins-success` | green-400 | |
| `--reins-warning` | amber-400 | |
| `--reins-danger` | red-400 | |
| `--reins-danger-surface` | red-400/10 | error boxes |
| `--reins-font-sans`, `--reins-font-mono` | the app's | |
| `--reins-text-2xs`, `-xs`, `-sm`, `-base`, `-lg` | 10px, 12px, 14px, 16px, 18px | (with line heights) |
| `--reins-radius-sm`, `-md`, `-lg`, `-full` | 4px, 6px, 8px, 9999px | |
| `--reins-tone-attention`, `-info`, `-neutral` | amber-300, `--reins-accent-text`, `--reins-text-secondary` | badges' text (added with the kit) |
| `--reins-tone-attention-surface`, `-info-surface`, `-neutral-surface` | amber-500/15, blue-500/15, zinc-500/15 | badges' background |

Spacing stays Tailwind's scale (`--spacing`), which the theme file sets to the app's. Status colors of activity (running, unread) can join when a second extension shows sessions.

## Slices

1. **Tokens in the app.** `packages/frontend/src/components/tokens.css` defines the variables on `:root` (started: the kit's tokens are defined, `theme.css` names them for Tailwind, and the kit reads them); `@reins/sdk/tailwind.css` maps Tailwind names to them and the app's `app.css` uses it. The app looks the same. Test: every token the SDK lists is defined in `tokens.css`, and every one `tailwind.css` references is listed.
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

1. ~~Shadow root or light DOM for kit components?~~ Light DOM (*Slice 1: decisions*).
2. ~~The SDK package or a package of its own?~~ Its own, `packages/ui`, versioned with the SDK (*Slice 1: decisions*).
3. Should `text-[10px]`, used 113 times, become the `2xs` step, or should the app's small text settle on fewer sizes first?
