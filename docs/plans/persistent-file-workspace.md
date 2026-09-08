# Persistent File Workspace and Message References

Status: **proposed**

## Goal

Make project files durable resources within the Reins workspace and automatically turn real file references in completed messages into controls that open those resources.

The first version is client-driven. Agents do not need to emit special Markdown links, plugins do not need a file-link element, and files do not need browser routes or a custom URL scheme.

## Product model

A file is addressed inside Reins by a project-relative reference:

```ts
interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
}
```

There is one long-lived file workspace model for the active project. It survives:

- showing and hiding the file view
- switching between Chat, Changes, and File
- switching sessions within the same project
- opening several file references in succession

Changing projects disposes or resets the active file workspace. Retaining a map of workspaces for previously visited projects is unnecessary initially and can be added if returning to a project should restore its exact prior state.

The central operation is conceptually:

```ts
fileWorkspace.open(reference);
```

Message references, file search, tool actions, and Changes file actions should eventually converge on this operation rather than coordinating the viewer directly.

## Why this is not routing

Reins is a visual IDE, not a general-purpose browser. File references do not initially need web navigation semantics such as opening a new tab, copying a URL, or restoring from a browser route.

The durable identity is `FileReference`, not an `href`. The backend content endpoint remains responsible for safely reading bytes, but it does not define the frontend resource model.

A serializable reference still leaves room for agents or plugins to cite files later. If that becomes useful, their representation should translate into the same `FileReference`; it should not create another file-opening path. That future interface is deliberately outside this first pass.

## Current problem

`AppShell` already owns one long-lived `FileBrowserStore`, but the file browser treats its state as temporary:

- opening the overlay resets the store
- closing the overlay resets the store
- selection, content, tree expansion, and viewer state are discarded
- the component is controlled imperatively through a queried element
- “files” in the responsive workspace currently means the changed-files tree, while the complete project file browser is a separate overlay

This makes a file feel like a temporary preview rather than part of the workspace.

## File workspace lifecycle

The project-scoped model should own or coordinate:

- the active project identity
- the selected `FileReference`
- the project file inventory and reference index
- directory entries and expansion state
- selected file content, MIME/binary state, loading, and errors
- code/preview mode
- line highlighting
- enough per-file view state to restore the useful reading position after switching away
- cancellation or generation checks so responses from an old project cannot update the new project

Visibility is presentation state. Hiding or closing the file surface must not reset the model. Reset occurs only when the project changes, the user explicitly requests it, or the model is disposed.

For the first version, content can be reloaded rather than persisted across application restarts. Lightweight project selection state may later be stored locally if restart restoration proves valuable.

## Workspace presentation

The intended direction is for File to become a first-class workspace destination alongside Chat and Changes rather than remaining only a modal preview.

The exact desktop composition needs a focused UI decision before implementation. A likely shape is:

- the main area displays the selected file
- the right pane displays the complete project tree while File is active
- Chat and Changes retain their existing behavior
- mobile uses a full File page with a tree toggle

The initial implementation may preserve the overlay while fixing lifecycle and state ownership, provided that doing so does not hardwire overlay behavior into the new model. The model must support a persistent pane without redesign.

The existing workspace terminology should be clarified as part of this work: the current right-side `files` pane is a changed-files navigation tree, not the project file workspace.

## Automatic message references

Completed messages should be scanned for plausible file references in both ordinary prose and inline code. A reference becomes interactive only when it resolves to a real file in the active project.

Examples:

```text
packages/frontend/src/components/chat-message.ts
README.md
chat-message.ts:127
packages/frontend/src/components/app.ts#L120-L135
/home/will/Workspaces/reins/docs/TODO.md
```

Resolution rules for the first version:

- normalize absolute paths contained within the active project to project-relative paths
- reject absolute paths outside the project and references containing traversal
- recognize optional line and line-range suffixes
- prefer the longest valid match when candidates overlap
- resolve full relative paths exactly
- resolve a bare basename only when it is unique in the project inventory
- preserve surrounding punctuation
- do not decorate URLs, existing Markdown links, images, or fenced code blocks
- do not decorate while a message is streaming
- leave unresolved or ambiguous text unchanged

Repository validation makes scanning prose safe enough while avoiding a syntax-only linkifier. It also means references to deleted or unavailable files remain ordinary text.

## File inventory and freshness

Reuse the existing project file listing rather than introducing a second source of filesystem truth. The file workspace should build an efficient lookup index from that listing and share it with message-reference resolution.

The index must account for files created during the current turn. Refresh it once after an agent turn completes, and also through existing explicit file refresh operations. Avoid fetching or scanning the full repository separately for every rendered message.

Hydrated conversations may render before the inventory is ready. They should render normally first and gain file controls when the project index becomes available. Resolution results should be cached per inventory generation and invalidated when that generation changes.

The matching implementation must not compare every repository path against every text node. Build an index suitable for exact full-path lookup, unique-basename lookup, and efficient longest-match candidate resolution.

## Markdown decoration

Decoration is a presentation transform. It must not modify:

- persisted message text
- provider conversation history
- copied message Markdown
- compaction input

Apply decoration through Markdown tokens or rendered text nodes, not by applying a regular expression to generated HTML. Existing anchors and code blocks must retain their semantics. Activating a decorated reference passes its `FileReference` to the file workspace and reveals the file surface.

The same resolver should work for user and assistant messages when they belong to the active project's conversation.

## Proposed implementation slices

### 1. Establish the persistent project-scoped model

Evolve or replace `FileBrowserStore` so project identity and lifecycle are explicit. Stop resetting resource state when the current overlay is shown or hidden. Guard asynchronous file-list, tree, and content responses across project changes.

Route existing file search and file-opening actions through the model's small interface.

### 2. Separate the file view from overlay lifecycle

Make the existing viewer render from persistent workspace state. Preserve selected file, view mode, tree expansion, and useful reading position when the surface is hidden and shown.

This slice may retain the current visual overlay while removing its ownership of resource state.

### 3. Add repository-validated message decoration

Build the project file-reference index, parse path and line-range forms, decorate completed Markdown, and open references through the file workspace. Refresh the index after completed turns so newly created files can be cited immediately.

### 4. Promote File to a workspace destination

Replace the temporary overlay presentation with the chosen desktop and mobile File workspace. Rename the existing changed-files pane concepts where needed so `files` no longer means two different things.

### 5. Generalize only when needed

If agents or plugins later need to generate explicit file controls, expose the same `FileReference` and open operation through an appropriate interface. Do not design a URL scheme, Markdown protocol, or plugin element until there is a concrete caller.

## Verification

Cover at least:

- hiding and reopening preserves selected file and viewer state
- session changes within one project preserve file state
- project changes clear state and ignore stale asynchronous responses
- full relative and contained absolute paths resolve
- unique basenames resolve and ambiguous basenames do not
- line and line-range suffixes become `FileReference` fields
- surrounding punctuation is not included
- URLs, traversal, fenced code, existing links, and missing files remain unchanged
- completed messages gain controls when an asynchronously loaded index arrives
- streaming messages are not repeatedly decorated
- activating a decorated path selects the file and reveals the workspace
- copied message Markdown remains the original undecorated text

Add a small browser-level interaction test once File is promoted into the responsive workspace, covering selection, pane switching, and restoration on desktop and mobile.

## Non-goals

- browser-addressable file routes
- opening file references in new windows or tabs
- agent instructions for explicit links
- a custom `reins://` or file URL scheme
- plugin file-link interfaces
- immutable file snapshots or references that survive renames
- editing files
- multiple open file tabs
- retaining every project's complete file contents in memory
