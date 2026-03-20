/**
 * Bash tool renderer.
 *
 * Terminal-style block: command is always visible with a `$` prompt.
 * Expanding reveals the output below. Does NOT use the generic
 * `renderCollapsibleTool` helper — owns its full rendering surface.
 */

import { html, nothing } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (tested without DOM)
// ---------------------------------------------------------------------------

/** Extract the full command string from a Bash tool block. */
export function getBashCommand(block: ToolBlockData): string {
  return block.args?.command ?? "";
}

/** Extract the first line of output text for a compact preview. */
export function getBashPreview(block: ToolBlockData, maxLen = 120): string {
  const texts = block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text) ?? [];

  const joined = texts.join("\n").trim();
  if (!joined) return "";

  const firstLine = joined.split("\n")[0];
  if (firstLine.length > maxLen) {
    return firstLine.slice(0, maxLen - 1) + "…";
  }
  return firstLine;
}

/** Get the full output text from a Bash tool block. */
export function getBashOutput(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

/** Get exit/error info from a Bash tool block. */
export function getBashExitInfo(block: ToolBlockData): { isError: boolean; label: string } {
  if (block.status === "running") {
    return { isError: false, label: "running" };
  }
  if (block.isError) {
    return { isError: true, label: "error" };
  }
  return { isError: false, label: "ok" };
}

// ---------------------------------------------------------------------------
// Shared terminal block rendering
// ---------------------------------------------------------------------------

function renderTerminalBlock(opts: {
  command: string;
  isError: boolean;
  showSpinner?: boolean;
  expanded?: boolean;
  output?: string;
  onToggle?: () => void;
  images?: { type: "image"; data: string; mimeType: string }[];
}) {
  const borderColor = opts.isError
    ? "border-red-500/60"
    : opts.showSpinner
      ? "border-yellow-500/60"
      : "border-zinc-700";

  const hasOutput = !!(opts.output?.trim());
  const clickable = !opts.showSpinner && (hasOutput || (opts.images && opts.images.length > 0));

  return html`
    <div
      class="mt-1 mb-1 ml-2 rounded-md bg-zinc-950 border ${borderColor} overflow-hidden ${clickable ? "cursor-pointer" : ""}"
      @click=${clickable ? opts.onToggle : nothing}
    >
      <!-- Command area -->
      <div class="px-3 py-2 flex items-start gap-2">
        ${opts.showSpinner
          ? html`<span class="inline-block w-3 h-3 mt-0.5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
          : nothing}
        <pre class="text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words m-0 flex-1 min-w-0"><span class="text-green-500 select-none">$ </span>${opts.command || "…"}</pre>
        ${opts.isError
          ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0 self-start">error</span>`
          : nothing}
      </div>

      <!-- Output area (only when expanded) -->
      ${opts.expanded && hasOutput ? html`
        <div class="border-t border-zinc-800">
          <pre class="px-3 py-2 text-xs font-mono ${opts.isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">${opts.output}</pre>
        </div>
      ` : nothing}

      <!-- Images (show when expanded, or always if no text output) -->
      ${opts.images && opts.images.length > 0 && (opts.expanded || !hasOutput) ? html`
        <div class="border-t border-zinc-800 p-2">
          ${opts.images.map(
            (img) => html`<img src="data:${img.mimeType};base64,${img.data}" class="max-w-full max-h-96 rounded mt-1" alt="Tool result image" />`,
          )}
        </div>
      ` : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export const bashRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const cmd = getBashCommand(block);
    return renderTerminalBlock({
      command: cmd,
      isError: false,
      showSpinner: true,
    });
  },

  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void) {
    const cmd = getBashCommand(block);
    const output = getBashOutput(block);
    const exitInfo = getBashExitInfo(block);
    const images = block.result?.content?.filter(
      (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
    ) ?? [];

    return renderTerminalBlock({
      command: cmd,
      isError: exitInfo.isError,
      expanded,
      output,
      onToggle,
      images,
    });
  },
};
