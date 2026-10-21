# Mobile Navigation

On mobile, REINS uses a horizontal swipe model:

1. Project/session sidebar
2. Chat
3. Changes
4. Inspector: the same tabs as the desktop Inspector ([workspace-panes.md](workspace-panes.md) *The Inspector*), starting with the changed-files tree, each tab a page of its own

Swipe left or right to move one pane at a time. Past Changes, swiping goes through the Inspector's tabs in order: left from Changes reaches the first tab, each further swipe the next one, and right from the first tab returns to Changes. The tab strip stays in place while the tabs' content slides, and shows which tab you are on; tapping a tab goes straight to it. During a swipe, the adjacent pane follows the drag for immediate feedback; when released, the view snaps to the current pane or the next pane depending on drag distance/velocity. Chat and Changes each carry their own toolbar, so the header moves with the pane instead of popping in after the swipe settles.

Opening something in the Inspector (a file named in a message, **Open in Inspector** in the file browser or file search) moves to the Inspector page.

The far-right toolbar overflow menu includes **Copy session ID** while a session is active. In an installed PWA it also includes **Reload**.

Vertical scrolling remains available inside panes. Horizontally scrollable content, such as wide diff/code rows or an overflowing Inspector tab strip, owns horizontal drags even at its scroll edges; drags from non-scrollable areas can still change panes. In a file whose code scrolls sideways, swipe from its header to change tabs. In list-style sidebars and the Inspector's tab strip on mobile, horizontal drags can start on buttons so the pane still feels swipeable; taps still activate them. Form fields and contenteditable areas are ignored so controls keep their native behavior.
