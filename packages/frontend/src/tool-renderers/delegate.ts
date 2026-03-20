/**
 * delegate tool renderer.
 *
 * Card-style layout that visually distinguishes delegated work from
 * regular tool calls. Shows truncated prompt when collapsed,
 * full prompt + result summary when expanded.
 *
 * Owns its full rendering surface (does NOT use the generic
 * `renderCollapsibleTool` helper).
 */

import { html, nothing } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (tested without DOM)
// ---------------------------------------------------------------------------

/** Extract a truncated prompt summary (first ~80 chars) from a delegate tool block. */
export function getDelegateSummary(block: ToolBlockData, maxLen = 80): string {
  const prompt = block.args?.prompt;
  if (!prompt || typeof prompt !== "string") return "";
  if (prompt.length <= maxLen) return prompt;
  return prompt.slice(0, maxLen) + "…";
}

/** Extract the full prompt text from a delegate tool block. */
export function getDelegateDetail(block: ToolBlockData): { prompt: string } {
  return {
    prompt: block.args?.prompt ?? "",
  };
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

function renderDelegateCard(opts: {
  prompt: string;
  summary: string;
  isRunning?: boolean;
  isError?: boolean;
  expanded?: boolean;
  resultText?: string;
  onToggle?: () => void;
}) {
  const borderColor = opts.isError
    ? "border-purple-500/60"
    : opts.isRunning
      ? "border-purple-400/60"
      : "border-purple-600/40";

  const clickable = !opts.isRunning;

  return html`
    <div
      class="mt-1 mb-1 ml-2 rounded-lg border ${borderColor} bg-zinc-950/80 overflow-hidden ${clickable ? "cursor-pointer" : ""}"
      @click=${clickable ? opts.onToggle : nothing}
    >
      <!-- Header -->
      <div class="px-3 py-2 flex items-center gap-2 bg-purple-500/5">
        ${opts.isRunning
          ? html`<span class="inline-block w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
          : html`<span class="text-xs flex-shrink-0">${opts.expanded ? "▼" : "▶"}</span>`}
        <span class="text-purple-400 flex-shrink-0">⑂</span>
        <span class="text-xs font-semibold text-purple-300 flex-shrink-0">delegate</span>
        ${opts.isError
          ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
          : nothing}
        ${opts.isRunning
          ? html`<span class="text-[10px] text-purple-400/70 flex-shrink-0">running…</span>`
          : nothing}
      </div>

      <!-- Prompt summary (always visible) -->
      <div class="px-3 py-2 border-t border-purple-500/10">
        <pre class="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words m-0 ${opts.expanded ? "" : "line-clamp-2"}">${opts.expanded ? opts.prompt : opts.summary}</pre>
      </div>

      <!-- Result (only when expanded and available) -->
      ${opts.expanded && opts.resultText ? html`
        <div class="border-t border-purple-500/10">
          <div class="px-3 pt-2 pb-1">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-purple-400/60">Result</span>
          </div>
          <pre class="px-3 pb-2 text-xs font-mono ${opts.isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">${opts.resultText.slice(0, 5000)}</pre>
        </div>
      ` : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export const delegateRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const summary = getDelegateSummary(block);
    const { prompt } = getDelegateDetail(block);

    return renderDelegateCard({
      prompt,
      summary: summary || "delegating…",
      isRunning: true,
    });
  },

  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void) {
    const summary = getDelegateSummary(block);
    const { prompt } = getDelegateDetail(block);

    const resultText = block.result?.content
      ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n") ?? "";

    return renderDelegateCard({
      prompt,
      summary: summary || "delegate",
      isError: block.isError,
      expanded,
      resultText,
      onToggle,
    });
  },
};
