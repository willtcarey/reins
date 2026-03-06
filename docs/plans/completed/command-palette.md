# Command Palette

Quick-navigate across all projects, tasks, and sessions via a Cmd+K / Ctrl+K modal overlay.

## 1. UI

- **Trigger**: `Cmd+K` (Mac) / `Ctrl+K` (other) keyboard shortcut (toggles open/closed), plus a search button in the top bar for mobile
- **Modal overlay**: Centered dialog with a search input and scrollable result list, rendered in `app-shell`
- **Dismiss**: Escape key, clicking backdrop, selecting an item, or pressing Cmd+K again
- **Focus**: Input auto-focused on open. Focus returns to previous element on close.
- **Component**: `<command-palette>` — a Lit component that receives `activityMap` and emits navigation events (decoupled from AppStore)

## 2. Results

Every result is a session. Each item displays:

- **Project name** — always shown
- **Context** — "Assistant" for scratch sessions, task title for task sessions
- **Preview** — first message, truncated
- **Activity dot** — from client-side `activityMap` (running = green pulse, finished = amber)

Sessions with no messages are excluded.

Fuzzy search matches against project name, task title, and first message. So typing "rei" surfaces:
- The **Reins** project's assistant session (matched on project name)
- Any task sessions in any project whose task title matches "rei"
- Any sessions whose first message matches "rei"

## 3. Default List (No Query)

Recent sessions ordered by `updated_at DESC`. Activity dots shown but don't reorder.

## 4. Search & Ranking

Client-side fuzzy matching (fzf-style). Each item has a searchable string composed of project name + task title/Assistant + first message. Ranking: fuzzy match score first, then `updated_at DESC` as tiebreaker.

## 5. Data

### Backend: `GET /api/palette`

Single endpoint that returns the full search index. No query parameter — all filtering is client-side.

Returns a flat list of sessions with context:

```ts
interface PaletteItem {
  sessionId: string;
  projectId: number;
  projectName: string;
  taskId: number | null;
  taskTitle: string | null;
  firstMessage: string | null;
  updatedAt: string;
}
```

The query joins `sessions` → `projects` → `tasks` (left join) and the first-user-message subquery (same pattern already used in `session-store.listSessions`). Filters out sessions with no messages (`message_count = 0`). Ordered by `updated_at DESC`.

The payload is small — even hundreds of sessions is a few KB.

### Frontend

- Keep a cached copy of the index. On palette open, immediately filter against the cached copy (so search works instantly), and fire off a background refetch. When the fresh response arrives, replace the cache and re-run the current filter.
- First open ever: show a loading state until the initial fetch completes.
- Filter and rank client-side with fuzzy matcher as user types — instant, no debounce needed.
- Overlay `activityMap` states for running/finished dots.

## 6. Navigation

- Selecting an item calls `navigateToSession(sessionId)` and closes the palette
- **Keyboard**: Arrow keys navigate the list (with wrap-around), Enter selects. First item is pre-selected on open and after each filter change. Selected item scrolls into view.
- The existing route handling in `app-shell` takes care of loading the session, updating the diff store, etc.

## 7. Mobile

- Add a search/command button (magnifying glass icon) in the top bar next to the hamburger menu
- Same modal behavior — full-width on small screens
- Touch-friendly: items have adequate tap targets (py-3)

## 8. Implementation Plan

1. **Backend**: Add `listPaletteItems()` to `session-store.ts` and `GET /api/palette` route
2. **Backend tests**: Test the query (joins, message filtering, ordering)
3. **Frontend**: Create `command-palette.ts` component with fuzzy search
4. **Frontend**: Wire keyboard shortcut and mobile button in `app-shell`
5. **Frontend tests**: Test fuzzy matching, ranking, keyboard navigation
