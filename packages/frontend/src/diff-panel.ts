/**
 * Herald Diff Panel
 *
 * Lit web component that fetches and displays the git diff from the backend.
 * Parses unified diff format and renders with colored additions/removals.
 * Supports expanding context lines around changed hunks.
 * Uses light DOM for Tailwind compatibility.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

// ---- Diff parser types -----------------------------------------------------

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  text: string;
  lineNo?: number; // line number in the new file (for context lines)
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
  /** Starting line number in old file */
  oldStart: number;
  /** Starting line number in new file */
  newStart: number;
}

interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

// ---- Diff parser -----------------------------------------------------------

function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const match = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (match) {
    return { oldStart: parseInt(match[1], 10), newStart: parseInt(match[2], 10) };
  }
  return { oldStart: 0, newStart: 0 };
}

function parseDiff(raw: string): DiffFile[] {
  if (!raw || !raw.trim()) return [];

  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let newLineNo = 0;

  for (const line of lines) {
    // New file header: diff --git a/path b/path
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.*?) b\/(.*)/);
      currentFile = {
        path: match ? match[2] : line,
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    // Skip metadata lines (index, ---, +++)
    if (line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    // New mode / deleted / renamed lines
    if (
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("similarity index") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    if (line.startsWith("@@")) {
      if (!currentFile) continue;
      const { oldStart, newStart } = parseHunkHeader(line);
      newLineNo = newStart;
      currentHunk = {
        header: line,
        lines: [],
        oldStart,
        newStart,
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    // Diff content lines
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", text: line.slice(1), lineNo: newLineNo });
        newLineNo++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "remove", text: line.slice(1) });
        // removed lines don't increment new file line number
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: "context", text: line.slice(1), lineNo: newLineNo });
        newLineNo++;
      } else if (line === "\\ No newline at end of file") {
        // Skip this marker
      }
    }
  }

  return files;
}

// ---- Constants -------------------------------------------------------------

const DEFAULT_CONTEXT = 3;
const EXPAND_STEP = 20;

// ---- Component --------------------------------------------------------------

@customElement("herald-diff")
export class HeraldDiff extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Current project ID from the URL route. Null = no project selected. */
  @property({ type: Number })
  activeProjectId: number | null = null;

  @state() private files: DiffFile[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private collapsedFiles = new Set<string>();
  @state() private contextLines = DEFAULT_CONTEXT;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 5000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refresh() {
    if (this.activeProjectId == null) {
      this.files = [];
      this.error = null;
      return;
    }
    try {
      const resp = await fetch(`/api/projects/${this.activeProjectId}/diff?context=${this.contextLines}`);
      if (!resp.ok) {
        this.error = `HTTP ${resp.status}`;
        return;
      }
      const data = await resp.json();
      const combined = [data.committed ?? "", data.uncommitted ?? ""]
        .filter(Boolean)
        .join("\n");
      this.files = parseDiff(combined);
      this.error = null;
    } catch (err: any) {
      this.error = err.message ?? "Failed to fetch diff";
    }
  }

  private toggleFile(path: string) {
    const next = new Set(this.collapsedFiles);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.collapsedFiles = next;
  }

  private async expandContext() {
    this.contextLines += EXPAND_STEP;
    await this.refresh();
  }

  private async resetContext() {
    this.contextLines = DEFAULT_CONTEXT;
    await this.refresh();
  }

  private renderLine(line: DiffLine) {
    let prefix = " ";
    let classes = "text-zinc-300";
    const lineNoStr = line.lineNo != null ? String(line.lineNo).padStart(4) : "    ";

    switch (line.type) {
      case "add":
        prefix = "+";
        classes = "diff-add";
        break;
      case "remove":
        prefix = "-";
        classes = "diff-remove";
        break;
      case "context":
        prefix = " ";
        classes = "text-zinc-400";
        break;
    }

    return html`<div class="${classes} px-2 leading-5 whitespace-pre font-mono"><span class="select-none text-zinc-600 mr-1 inline-block w-[3.5ch] text-right">${line.lineNo != null ? line.lineNo : ""}</span><span class="select-none text-zinc-600 mr-2">${prefix}</span>${line.text}</div>`;
  }

  private renderExpandButton(label: string, onClick: () => void) {
    return html`
      <button
        class="w-full py-1 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 cursor-pointer flex items-center justify-center gap-1 border-t border-zinc-700/50 transition-colors"
        @click=${onClick}
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
        ${label}
      </button>
    `;
  }

  private renderHunkSeparator(prevHunk: DiffHunk | null, nextHunk: DiffHunk) {
    // If there's a gap between hunks, show an expand button
    if (!prevHunk) {
      // First hunk — if it doesn't start at line 1, there are lines above we could show
      if (nextHunk.newStart > 1) {
        return this.renderExpandButton(
          `Show more lines above`,
          () => this.expandContext()
        );
      }
      return nothing;
    }

    // Calculate the gap between the end of prevHunk and start of nextHunk
    const prevEndLine = this.getHunkEndLine(prevHunk);
    const gap = nextHunk.newStart - prevEndLine - 1;
    if (gap > 0) {
      return this.renderExpandButton(
        `Expand ${gap} hidden line${gap !== 1 ? "s" : ""}`,
        () => this.expandContext()
      );
    }

    return nothing;
  }

  private getHunkEndLine(hunk: DiffHunk): number {
    // Walk backwards through lines to find the last new-file line number
    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const line = hunk.lines[i];
      if (line.lineNo != null) return line.lineNo;
    }
    return hunk.newStart;
  }

  private renderFile(file: DiffFile) {
    const collapsed = this.collapsedFiles.has(file.path);
    const addCount = file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
      0
    );
    const removeCount = file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "remove").length,
      0
    );

    return html`
      <div class="mb-3 border border-zinc-700 rounded-lg">
        <button
          class="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-750 text-sm cursor-pointer sticky top-0 z-10 rounded-t-lg border-b border-zinc-700"
          @click=${() => this.toggleFile(file.path)}
        >
          <span class="text-zinc-500 font-mono text-xs">${collapsed ? "▶" : "▼"}</span>
          <span class="font-mono text-zinc-200 flex-1 text-left truncate">${file.path}</span>
          ${addCount > 0 ? html`<span class="text-green-400 text-xs font-mono">+${addCount}</span>` : nothing}
          ${removeCount > 0 ? html`<span class="text-red-400 text-xs font-mono">-${removeCount}</span>` : nothing}
        </button>
        ${!collapsed ? html`
          <div class="text-xs overflow-x-auto">
            ${file.hunks.map(
              (hunk, i) => html`
                ${this.renderHunkSeparator(i > 0 ? file.hunks[i - 1] : null, hunk)}
                <div class="bg-zinc-900/50 px-2 py-1 text-zinc-500 text-xs border-t border-zinc-700 font-mono">
                  ${hunk.header}
                </div>
                ${hunk.lines.map((line) => this.renderLine(line))}
              `
            )}
          </div>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    if (this.error) {
      return html`
        <div class="flex items-center justify-center h-full text-red-400 text-sm p-4">
          Error: ${this.error}
        </div>
      `;
    }

    if (this.files.length === 0) {
      return html`
        <div class="flex items-center justify-center h-full text-zinc-500 text-sm">
          No changes yet
        </div>
      `;
    }

    return html`
      <div class="h-full overflow-y-auto p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-xs text-zinc-500">Context: ${this.contextLines} lines</span>
          ${this.contextLines > DEFAULT_CONTEXT
            ? html`<button
                class="text-xs text-zinc-500 hover:text-zinc-300 underline cursor-pointer"
                @click=${() => this.resetContext()}
              >Reset</button>`
            : nothing}
        </div>
        ${this.files.map((file) => this.renderFile(file))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "herald-diff": HeraldDiff;
  }
}
