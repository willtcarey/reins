# Conversation Tree

Status: **early thinking** — not ready for implementation.

## Motivation

Conversations with agents are naturally non-linear. You explore an approach, realize it's wrong, want to try something different. You want to ask a side question ("update this skill with what we just learned") without polluting the main conversation. You want to roll back to an earlier point without losing what you learned.

Pi already supports a tree-structured conversation internally (SessionManager with parent/child entries, fork/rollback with branch summarization). Reins currently flattens this into a linear message sequence for display and persistence. The goal is to expose the tree in the UI and let users navigate, fork, and roll back naturally.

## Core concepts

- **A session is a tree, not a list.** One session contains one conversation tree.
- **A node is a turn** — a user message paired with the agent's response (text, tool calls, tool results). Nodes are the unit of display and navigation.
- **The trunk** is the main conversation path.
- **Branches** are forks off any node — side conversations, alternative approaches, rollbacks.
- **The active branch** is where the user is currently chatting. New messages append to the active branch's leaf.

## Forking

From any node in the conversation, the user can fork:

- **Fork with summary** — Creates a new branch from that node. Everything after the fork point on the original branch is summarized and injected as context into the new branch. The agent knows what was tried and can take a different direction.
- **Fork without summary** — Creates a new branch from that node with no knowledge of what came after. Useful for independent side-quests ("update this skill with what we just discussed") that don't need context from the continuation.

Both the original branch and the new branch continue to exist. Neither is destroyed.

## Rollback

Rolling back is a specific case of forking — the user forks from an earlier node and makes the new branch the active one. The old continuation becomes a side branch. Optionally includes a summary of what was rolled back so context isn't lost.

## UI: Canvas

The conversation tree is displayed on a 2D canvas with pan and zoom. This avoids the fundamental problem of fitting a tree into a linear layout.

### Layout

```
    [user: "Let's build the API"]
              │
    [agent: implemented REST endpoints]
              │
    [user: "Add auth"]──────────[user: "Update the skill file"]
              │                            │
    [agent: added JWT auth]      [agent: updated skill]
              │
    [user: "Actually, use passkeys"]  ← (rollback with summary)
              │
    [agent: switched to passkeys]
```

- **Trunk flows top to bottom** — the main/active conversation path
- **Branches extend to the right** — forks split off horizontally
- **Each node is a turn** (user message + agent response)
- **The active branch is visually highlighted** (brighter, thicker connector line)
- **Branch summaries** appear as collapsed annotations on the fork point

### Zoom levels

- **Zoomed out** — Nodes are compact cards showing the first line of the user message and a status indicator (done, streaming, has branches). Good for orientation and navigation. The full tree is visible.
- **Zoomed in** — Nodes expand to show full conversation content (markdown, tool calls, tool results). Reading mode. Effectively looks like a normal chat as you scroll along a branch.
- **Intermediate** — Nodes show a few lines of preview. Enough to recognize what each turn was about without expanding fully.

The zoom is continuous (pinch on mobile, scroll wheel on desktop), not discrete levels.

### Navigation

- **Pan** — Click and drag (desktop), swipe (mobile) to move around the canvas
- **Zoom** — Scroll wheel (desktop), pinch (mobile)
- **Click a node** — Selects it, shows context menu (fork, rollback, continue from here)
- **Double-click a node** — Zooms in to read it
- **Follow active branch** — A button/shortcut to snap the view to the current conversation leaf (like "scroll to bottom" in the current chat)

### Input

The chat input is always at the bottom of the viewport (fixed position, not on the canvas). It appends to the active branch's leaf node. When the user forks from an earlier node, the input context switches to the new branch.

### Streaming

When the agent is responding, the leaf node of the active branch grows in real-time — same streaming behavior as the current chat, just rendered within a canvas node. The canvas auto-pans to keep the streaming node visible.

## Data model

One session = one tree of turns. Each turn is a node with:

- An ID
- A parent node ID (null for root)
- User message content
- Agent response content (messages, tool calls, tool results)
- Optional branch summary (if this node is a fork point with a summary)
- Timestamps

This is conceptually similar to pi's SessionManager entry tree but structured around turns rather than individual messages. The persistence layer stores the tree (not a flattened sequence) so the structure survives server restarts.

### Relationship to pi's SessionManager

Pi already maintains a tree internally. Rather than duplicating the tree structure, Reins could persist pi's entry tree directly (or a close representation of it) and derive the turn-based display tree from it. The key pi operations we'd use:

- `appendMessage` — add a message to the current branch
- `appendCompaction` — store a compaction summary
- `branch()` — fork from a point
- `getBranch()` — get the path from root to current leaf
- `buildSessionContext()` — get the messages to send to the LLM (handles compaction, fork summaries)

## Implementation phases

The tree data model and the canvas UI are separable. The linear chat view can sit on top of a tree data model — it just renders one branch at a time. This enables a phased migration:

### Phase 1: Tree data model, linear view

Change persistence from flat `session_messages` sequence to a tree structure (nodes with parent IDs). The UI stays linear — it renders `getBranch()` (the path from root to current leaf), same as today. But fork and rollback actions become available from a context menu on any message turn.

At fork points, a subtle indicator shows "N branches" with a way to switch between them (e.g., "← 1/3 →" selector like pi's TUI). The display remains a single vertical conversation.

This phase is the big backend/persistence change but low UI risk. Everything looks and feels like today, with new branching capabilities layered on.

### Phase 2: Canvas view

Build the 2D canvas visualization as an alternative view. The linear view stays as the default. Users can switch to the canvas when they need to see the full tree structure, navigate between branches, or get oriented in a complex conversation.

This phase is the big UI work, but the data model is already done from Phase 1.

### Phase 3: Refinement

Let users choose their preferred view, or make the canvas the primary view once it's polished. Potentially make the canvas the default for sessions with branches, and linear the default for unbranched sessions.

## Open questions

1. **Canvas library** — Build pan/zoom from scratch (CSS transforms), use a canvas/WebGL library, or use something like d3 for layout? Need something that handles smooth zoom, pan, and dynamic node sizing as content streams in.
2. **Performance at scale** — A long conversation could have hundreds of nodes. The canvas needs to virtualize — only render nodes that are visible at the current zoom/pan position.
3. **How branches interact with tasks** — Currently a task has sessions and each session is linear. With tree sessions, does a task still have multiple sessions, or does one tree session replace multiple linear ones?
4. **Compaction within branches** — If a branch gets very long, it needs compaction. Does each branch compact independently? Does the trunk's compaction affect branches?
5. **Diff view per branch** — The changes tab currently shows one diff. With branches, different branches may have made different file changes. Does the diff view show changes for the active branch only?
6. **Collaboration** — If multiple users view the same session (future multi-user), do they see the same tree? Can they work on different branches simultaneously?
7. **Migration** — Existing linear sessions would need to be representable as single-branch trees. Should be straightforward (each message becomes a node in a straight line).
