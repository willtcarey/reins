# Mobile Navigation

On mobile, REINS uses a four-pane horizontal swipe model:

1. Project/session sidebar
2. Chat
3. Changes
4. Changed-files sidebar

Swipe left or right to move one pane at a time. During a swipe, the adjacent pane follows the drag for immediate feedback; when released, the view snaps to the current pane or the next pane depending on drag distance/velocity.

Vertical scrolling remains available inside panes. Horizontally scrollable content, such as wide diff/code rows, owns horizontal drags even at its scroll edges; drags from non-scrollable areas can still change panes. In list-style sidebars on mobile, horizontal drags can start on row buttons so the pane still feels swipeable; taps still activate the row. Form fields and contenteditable areas are ignored so controls keep their native behavior.
