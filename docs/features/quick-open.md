# Quick Open

Quick-navigate to sessions for open tasks and project assistants across all projects.

## Usage

- **Open**: `Cmd+K` (Mac) / `Ctrl+K` (other), or tap the magnifying glass icon on mobile
- **Close**: `Escape`, click the backdrop, select an item, or press `Cmd+K` again
- **Navigate**: Arrow keys move selection (with wrap-around), `Enter` selects
- **Search**: Type to fuzzy-filter across project names, task titles, and first messages

## Default List

When opened with no query, shows sessions from open tasks plus the latest project-assistant (scratch) session for each project, ordered by most recently updated. Sessions from closed tasks, sessions with no messages, older scratch sessions, and sub-sessions (from delegate) are excluded.

## Search

Fuzzy matching — characters must appear in order but not necessarily consecutively. Tighter matches rank higher. Matches against:

- Project name
- Open task title (or "Assistant" for the latest scratch session)
- First user message

## Activity Indicators

- 🟢 **Green pulsing dot** — session is currently running; it remains visible even after you open that session, until the agent loop ends or its task closes
- 🟠 **Amber dot** — session has finished with unread activity; opening the session clears it

Activity indicators are suppressed for sessions whose task has been closed.

## Mobile

A magnifying glass button appears in the top bar (next to the hamburger menu) on small screens.
