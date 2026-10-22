# ADR-031: Views Mount by Presentation; Decorations Are Inline Views

- **Status:** Accepted
- **Date:** 2026-10-22
- **Author:** Will (with Claude)

## Context

The Reins SDK ([reins-sdk.md](../dev/reins-sdk.md)) had two ways to put a feature's content on the page:

- **Views** named a custom element. The Inspector created it for each tab and set its `view` and `context`.
- **Message decorators** found pieces of completed message text, and the host gave each piece's wrapper (an element around the original text) to the decorator's `mount`, which returned a disposer. Before that, the host drew every piece as a `<button>` that opened a view.

That was two lifecycles for the same thing: content of a feature's own, put in a place the host owns. Plugin authors will use React, Svelte, Vue and others. A custom element is awkward for them to make, but every framework can "render into this element, then tear down": React `createRoot`/`unmount`, Svelte and Vue `mount`/`unmount`, Solid `render`.

## Decision

**A view has one lifecycle, a mount function, for each way it can be shown (its presentations). Message decorations are views shown inline.**

- **The mount contract.** `mount(target, view, context)` draws into `target`, an element the host made, and returns `{ update?(view, context), dispose?() }`. A new view object given to `update` means "show it afresh" (a view opened again). Without `update`, the host disposes and mounts again. After `dispose`, the host empties the target. The host never mounts a target twice without a dispose between. Plugins never define a custom element.
- **Presentations.** A renderer gives a mount for each presentation it supports. There are two now: `pane` (the Inspector's tabs, and later the main area) with the tab's title, description and icon, and `inline` (in place of a piece of message text). `popover` can be added later as one more key. A container stays a place with an identity (`ContainerId`, `"inspector"`) and offers a presentation: the Inspector offers `pane`.
- **Each presentation has its own context.** A `pane` gets `WorkspaceContext` (the source). An `inline` view gets `InlineContext`: that, plus the piece's `text`, whether it was a whole inline-code span (`code`), and `original()`, a new copy of what the host draws without a view (`<code>app.ts</code>`) for views that want the default look.
- **An inline view controls its piece completely.** It may draw the text, change it or draw something else. The host keeps the rest. It does not change the stored message, copied Markdown, provider history or compaction input. It keeps the fallback: the original text stays until the view mounts, comes back when it is disposed, and stays when no renderer shows the view inline. It decides where decorating may happen: prose and whole inline-code spans, never code blocks, HTML, links, images or a message still streaming.
- **Decorators only find ranges and name views.** They have `decorate(text, context) → { start, end, view }[]`, `decorateCode?(code, context) → View | null` and `onChange`. A piece has one view: where decorators overlap, the earlier registered wins, and a view without an inline presentation leaves its text alone.
- **One host element, `<reins-view-host>` (`ViewHost`), runs the lifecycle everywhere a view is shown**: an Inspector tab and a decorated piece. Connected with a presentation, view and context, it mounts into itself. A new view or context updates the view. Disconnected, it disposes. Properties set together apply once. A moved element disposes before it mounts again. The Changes tab uses it too: it is the `diff-file-tree` view, which `app-workspace` registers like any view, its mount reaching the app's diff and review stores because app code may (amended 2026-10-22; reins-sdk.md *Views over the app's state*).
- **How a view host inside Markdown gets its view.** Decorated Markdown and user text are HTML strings rendered with `unsafeHTML`, so a template cannot bind properties there. The HTML holds `<reins-view-host data-piece="N">` around the original text. After an update that rendered new HTML, the rendering element (`InlineViews`, for `markdown-content` and `decorated-text`) sets each view host's `presentation`, `view` and `context` from the piece at index N. The properties stay on the element, so a message that leaves the page and comes back mounts again without being rendered again.

Rejected:

- **Custom elements as the view contract for plugins** (as views were): every framework can mount into an element, but making a conforming custom element is extra work for React or Svelte authors, and it is a second lifecycle beside decorators' mount.
- **A mount on decorators only** (the previous version of this ADR): it worked, but views would keep their custom elements, so there would be two lifecycles. An inline view is a view, and the same renderer can show it as a pane or, later, as a popover.
- **The decorator returns HTML for a piece**: a string cannot carry listeners, the host would have to sanitize it, and user messages are not Markdown.
- **Semantic decorations, as on iOS** (`UITextItem`: a label, a primary action, a menu and a preview that the host draws): consistent and accessible, but it limits features to what the host designed. Anything new (a badge, a status) would need a host change.
- **The host keeps the text, and the view only adds around it**: the host would need rules for what a view may touch. A view that wants the default look has `original()`, and one that wants something else can draw it.
- **A view host that reads its view from a JSON attribute and its context from the nearest message**: views are serializable, but the context is not (`original()`), and finding the nearest message would tie the view host to message elements. Setting properties after render keeps the view host the same everywhere.

## Consequences

- The file view's `pane` mount creates its Lit element (`inspector-file-view`), sets its `view` and `context` on `update`, and removes it on dispose. Its behavior is unchanged.
- File references are the `file-reference` view (`{ path, startLine?, endLine? }`), which the file-references feature registers with an `inline` presentation beside its decorator. It draws the original text inside a `span` with `role="button"` that opens the file with `workspace.open`. What users see is unchanged.
- `ViewElement`, `ViewRenderer.element`, decorators' `mount` and their decoration values, `DecorationMounts` and its re-render on reconnect (`keyed`) are gone. The Inspector no longer creates elements from a name (`unsafeStatic`).
- The SDK contract's one DOM type is still an element that the host gives to a feature (`HTMLElement` as the target, `Node` from `original()`). It never takes markup or templates from a feature.
- An inline view can replace the text, so selecting and copying a message copies what the views drew. Copied Markdown (the copy action) is the stored text. No copy handler fixes up a selection yet.
- Details: [reins-sdk.md](../dev/reins-sdk.md) *Contribution points*; [frontend-architecture.md](../dev/frontend-architecture.md) *Views and the Inspector*, *Message decorations*; [workspace-inspector.md](../plans/workspace-inspector.md) *Slice 2d*.
