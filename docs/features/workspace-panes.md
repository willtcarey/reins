# Workspace panes

On desktop, drag the divider beside Sessions or the Inspector to resize it. Focus a divider and press Left or Right Arrow to adjust it in small steps. Press Home or double-click the divider to restore its default width. The Inspector's width goes with the tab it shows: Changes starts narrow and a file wide, and each kind of tab keeps the width you give it, so a file can be wide while Changes stays narrow (resetting restores only the shown kind's width). When a pane's width changes, the conversation keeps its place: read to its end, it stays at its end; scrolled up, the text at the bottom of the view stays there. The Sessions header can collapse to a narrow rail and expand again. Widths and collapse state are remembered on this device. On narrow screens the workspace continues to use swipeable Sessions, Chat, Changes, and Inspector pages; desktop widths do not change those pages.

## The Inspector

The right-hand pane is the **Inspector**: a strip of tabs that keeps things in reach beside the conversation. Its first tab, **Changes**, is the changed-files tree; it is always there and cannot be closed. Other tabs show project files.

- **Open a file in the Inspector** from the file browser (its **Open in Inspector** button, which keeps the file's highlighted lines and Code/Preview tab), from file search (⌘/Ctrl+Enter, or the Inspector button on a result), or by clicking a file named in a message (*File references in messages*, below).
- **A file opens once.** Opening a file that already has a tab focuses that tab and shows the file as asked, as a new tab would: the file is read again, lines the request names (a reference such as `app.ts:120`) are highlighted and scrolled into view, and its Code/Preview tab is the one the request names (Code when it names none).
- **Switch tabs** by clicking them; a tab keeps its scroll position, Code/Preview choice and highlighted lines while another is shown. **Close** a file tab with its × button (shown on the current tab and the one under the pointer; on a touch screen, on every tab) or a middle click; closing the current tab shows the one before it.
- **When the tabs overflow** the pane, scroll them sideways (a mouse wheel works too); the current tab is always scrolled into view, also when the pane is resized. A tab whose name is cut short keeps its extension, so `plan.ts` and `plan.md` stay apart.
- A file tab shows the file in the file viewer, as the file browser does ([file-browser.md](file-browser.md) *File Viewer*). The folder button in its header opens the file in the file browser, with the tab's lines and the Code/Preview tab you are on; the download button downloads it.
- Tabs stay while you switch between sessions that work in the same checkout, and when you leave the workspace (Settings, History) and come back. Switching to a session in another checkout closes them; Changes stays. They are not remembered across a reload.
- A file tab shows the file from the checkout it was opened from. Opening a tab again reads the file again; when a session working in that checkout changes files (a write, edit or command finishes, or a turn ends), open files are read again too.

## File references in messages

Files named in a finished message become links: click one to open the file in the Inspector (on a phone, the Inspector page opens too). This works in your messages and the agent's alike, in ordinary text and in inline code.

A name becomes a link only when it is a real file of the checkout you are viewing, as file search lists it (tracked and untracked files that are not ignored):

- a path from the project root: `packages/frontend/src/components/app.ts`, `README.md`, `./docs/TODO.md`
- an absolute path inside the checkout: `/home/you/project/docs/TODO.md`
- a file name alone, when only one file has it: `chat-message.ts` (a name several files share stays plain text)

In ordinary text, a name must have a `/` (`docs/TODO.md`, `./README.md`) or a line after it (`chat-message.ts:127`). A name alone, such as `README.md` or `chat-message.ts`, becomes a link only in inline code, because it is too often an ordinary word.

A line or range after the name opens the file at those lines, highlighted: `chat-message.ts:127`, `app.ts:120-135`, `app.ts:12:5` (line 12), `app.ts#L120-L135`, `README.md#L7`. Punctuation around a name (brackets, quotes, a final full stop or colon) stays outside the link.

Left as they are: links and URLs, images, code blocks, paths outside the checkout or climbing out of it (`..`), and anything that is not a file. A message being written is not linked until it is finished. Links are only how a message is shown: copying a message gives its text as it was written.

The list of files is read when you open a session and again whenever a session in that checkout changes files, so files the agent just created can be linked; messages shown before the list arrives gain their links when it does. While the session's node is offline nothing is linked.
