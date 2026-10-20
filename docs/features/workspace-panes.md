# Workspace panes

On desktop, drag the divider beside Sessions or the Inspector to resize it. Focus a divider and press Left or Right Arrow to adjust it in small steps. Press Home or double-click the divider to restore its default width. The Sessions header can collapse to a narrow rail and expand again. Widths and collapse state are remembered on this device. On narrow screens the workspace continues to use swipeable Sessions, Chat, Changes, and Inspector pages; desktop widths do not change those pages.

## The Inspector

The right-hand pane is the **Inspector**: a strip of tabs that keeps things in reach beside the conversation. Its first tab, **Changes**, is the changed-files tree; it is always there and cannot be closed. Other tabs show project files.

- **Open a file in the Inspector** from the file browser (its **Open in Inspector** button), or from file search (⌘/Ctrl+Enter, or the Inspector button on a result).
- **A file opens once.** Opening a file that already has a tab focuses that tab; if the request names lines, they are highlighted and scrolled into view.
- **Switch tabs** by clicking them; a tab keeps its scroll position, Code/Preview choice and highlighted lines while another is shown. **Close** a file tab with its × button or a middle click; the tab before it is shown.
- The folder button in a file tab's header opens the file in the file browser.
- Tabs belong to their project: switching sessions within the project keeps them, and another project has its own. They are not remembered across a reload.
- Files are read from the checkout of the session you are viewing. Opening a tab again reads the file again; after the agent finishes a turn, open files are read again too.
