# Session Notifications

## Goal

Provide visual feedback across the UI when sessions are running or have completed, so the user has at-a-glance awareness without needing to be on the active session.

## Session Activity States

Each session can be in one of three notification states:

| State | Visual | Meaning |
|-------|--------|---------|
| **Running** | Green pulsing dot | Agent is actively streaming |
| **Finished (unread)** | Static amber dot | Agent finished, user hasn't viewed yet |
| **Normal** | No indicator | Idle with no new activity, or already viewed |

**Clearing**: Clicking into a session (making it active) clears any "finished" indicator for that session.

## Implementation

### 1. Activity tracker (`activity-tracker.ts`)

A small reactive class that `app-shell` owns and drives from WS events:

- Maintains a `Map<sessionId, 'running' | 'finished'>` of session activity states
- Listens for `agent_start` → set `running`
- Listens for `agent_end` → set `finished` (unless it's the currently viewed session, then clear)
- Exposes a `viewed(sessionId)` method that clears the state for that session
- Fires a callback when state changes so consumers can re-render

### 2. Sidebar indicators (`session-list.ts`, `task-list.ts`)

- Accept the activity map as a property from `session-sidebar`
- Render a dot next to each session row based on its state:
  - Running: `<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse">`
  - Finished: `<span class="w-2 h-2 rounded-full bg-amber-500">`

### 3. Collapsed sidebar badge

- When sidebar is collapsed (narrow rail), show a small indicator dot if any sessions are running or have unread completions
- Green if any running, amber if only finished/unread

### 4. Favicon updates (`favicon-manager.ts`)

- Render the existing SVG favicon to a canvas
- Overlay a colored circle in the bottom-right corner (green for running, amber for finished)
- Set as favicon via data URL on a `<link>` element
- Clear back to default when all activity is resolved

### 5. Document title

- Update `document.title` to reflect activity:
  - `(2 running) REINS` — agents active
  - `(1 new) REINS` — agents finished, unread
  - `REINS` — all clear

## Files touched

- **New**: `src/activity-tracker.ts`, `src/favicon-manager.ts`
- **Modified**: `src/app.ts`, `src/session-sidebar.ts`, `src/session-list.ts`, `src/task-list.ts`
