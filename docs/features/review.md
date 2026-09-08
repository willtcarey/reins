# Review

The Changes tab lets you review the work an agent has done. It shows a syntax-highlighted diff alongside a navigable file tree sidebar. The diff always reflects the **selected session's branch** — not whatever branch happens to be checked out.

When viewing a task session, the diff shows changes on the task's branch compared to the base branch. When viewing a scratch session (no task), the diff shows the live working copy.

Each file header can collapse or expand the file's diff body with a spring animation while leaving the header available, and provides actions to open the file in Reins, copy its path, or download its current version. The animation is skipped when reduced motion is preferred. Collapsing while scrolled inside a file returns the viewport to that file's header so the spring begins visibly. Choosing a file in the tree while viewing Chat switches to Changes and waits for the selected renderer to mount before navigating; a collapsed target expands first.

## Diff modes

The file tree sidebar includes a dropdown at the top for switching between two diff modes:

### Branch changes (default)

Shows **all changes** on the selected session's branch compared to the base branch. This includes both committed and uncommitted work — the full picture of what the task branch has changed.

### Uncommitted changes

Shows **only uncommitted working-tree changes** — edits that haven't been committed yet. Useful when a task has accumulated many commits and you want to see just what's been modified since the last commit.

## Inline comments (virtualized renderer)

The experimental `virtualized` renderer supports inline review comments on old or new lines. Select a line number or drag a same-side line range, then use Pierre's gutter add action to open the inline composer. The selected lines remain highlighted while composing, but the now-redundant gutter add action is hidden. An anchored line remains subtly highlighted whenever its comment thread is present. Comments appear directly below their anchored code with the author and creation time; the thread does not repeat old/new line coordinates already communicated by its placement. Use **Add comment** to continue an existing thread. An open composer can be canceled.

Saved comments are synchronized to the open code review for the selected session's exact project/task scope and return after page refresh. Each saved comment can be deleted from its inline thread before the review is submitted. Unsaved composer text remains browser-local, survives file collapse/expand and virtual scrolling that remounts a file, and is discarded when its review scope or reviewed content changes. Reins saves the selected side and start line plus each selected row's context/addition/deletion kind and text as the comment anchor. The comment is placed again when those rows still match at their original coordinates or have one unambiguous contiguous match elsewhere in the rendered diff; Pierre-specific side and line placement is derived at render time. Changed, missing, or ambiguous selections stay saved but are not guessed onto a line.

A floating **Submit review** action appears in the lower-right corner once the open review has at least one saved comment; no submission action is shown for an empty review. It is enabled when the selected session is idle. Submission compiles saved comments into one ordinary user message. Each thread includes its path and the exact Git-native per-file patch that was displayed when the comment was saved, indented without reconstructing its lines. This retains `diff --git`, mode, index, file-marker, and hunk headers as well as the original addition/deletion markers. Comments on the same selection form one thread, with later comments marked as replies. Reins sends it to the session selected at click time and never steers an active turn. Once the message and review deletion commit atomically, the consumed review disappears; saving another comment starts a new review. Progress and submission errors appear with the floating action.

Outdated-thread navigation, reanchoring, comment editing, and collaborative synchronization are not implemented yet. Classic and `codeview` renderers do not show this comment interface.

Cross-side ranges are rejected. Files blocked by the large-file safeguard do not offer line comments because their line rows are not rendered.

## Hunk expansion

Each diff shows a few lines of context around changes by default. You can expand to see more of the surrounding file:

- **Above a hunk** — a button appears if there are hidden lines above the first visible line. Click to reveal more context upward.
- **Below a hunk** — a button at the bottom of the last hunk reveals more lines below.
- **Between hunks** — when two hunks are separated by hidden lines, controls show how many lines are hidden. If the gap is small (≤ 15 lines), one **Expand** control reveals them all upward from the following hunk. For larger gaps, separate controls reveal context downward from the preceding hunk or upward from the following hunk.

When expanding closes the gap between two adjacent hunks, they automatically merge into a single hunk. In the leading hidden region before the first hunk, activating the unmodified-lines link expands only toward that hunk rather than opening both ends of the region. The complete resulting file is fetched on demand (not included in the initial diff payload), while the reviewed Git patch reconstructs its previous version in the browser. New and deleted files already carry their complete one-sided content in the patch. Expanded lines are syntax-highlighted in the background, and upward expansion keeps your scroll position anchored on the original hunk content. If content changed since the patch was loaded, retrieval fails, or the file is binary or over 1 MiB, the existing partial diff remains in place.

## Large file safeguards

A single file with more than 10,000 changed lines (additions plus removals) keeps its file header and actions available, but its diff rows are not rendered. Reins shows the changed-line count and limit in place of the body. This applies to every diff renderer and prevents generated files or large data snapshots from monopolizing rendering and syntax-highlighting work; other files in the review remain available normally.

## Markdown files

Markdown files (`.md`, `.mdx`, `.markdown`) get two view modes toggled via tabs above the diff:

- **Diff** (default) — the normal syntax-highlighted diff with word wrapping enabled
- **Preview** — the rendered markdown content of the current file version. Mermaid diagrams (` ```mermaid ` fenced code blocks) are rendered as SVG diagrams.

## Sync status

The diff header shows how the selected session's branch relates to the base branch and the remote.

Next to the **base branch name**:

- **N ahead** — the base branch has moved ahead since the task branched. A **Rebase** button appears to rebase the task branch onto the latest base branch.

Next to the **task branch name**:

- **N ahead** — commits on the task branch since it diverged from the base branch.
- **N unpushed** — commits that haven't been pushed to origin. A **Push** button appears to push them. The Push button also appears when the branch has never been pushed.
- **N behind origin** — someone else has pushed to this branch on the remote (rare in single-developer workflows).

Remote-aware numbers (unpushed, behind origin) are refreshed periodically in the background via `git fetch`. Local numbers update more frequently since they only read local refs.
