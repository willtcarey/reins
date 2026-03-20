/**
 * Tool renderer base helpers.
 *
 * Reusable rendering functions and pure logic that tool-specific
 * renderers can opt into.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { ToolBlockData } from "../chat-state.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (easily testable, no DOM)
// ---------------------------------------------------------------------------

/**
 * Return a short contextual summary for a tool call based on its name & args.
 *
 * Extracted from the former `ChatPanel.toolSummary()` method so it can be
 * tested as a pure function and reused across renderers.
 */
export function getToolSummary(name: string, args: Record<string, any> | undefined): string {
  if (!args) return "";
  switch (name.toLowerCase()) {
    case "bash":
      return args.command ?? "";
    case "read":
      return args.path ?? "";
    case "edit":
      return args.path ?? "";
    case "write":
      return args.path ?? "";
    default:
      // Generic: show first string-valued arg as context
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.length > 0) {
          return v.length > 120 ? v.slice(0, 117) + "…" : v;
        }
      }
      return "";
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers (return Lit TemplateResult)
// ---------------------------------------------------------------------------

/** Standard running indicator with spinner and left border. */
export function renderRunningTool(opts: {
  name: string;
  summary: TemplateResult | string;
  borderColor?: string;
}): TemplateResult {
  const border = opts.borderColor ?? "border-yellow-500";
  return html`
    <div class="mt-1 mb-1 ml-2 border-l-2 ${border} pl-3">
      <div class="flex items-center gap-2 text-xs text-zinc-400 truncate" title="${opts.summary || opts.name}">
        <span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>
        <span class="font-mono font-semibold flex-shrink-0">${opts.name}</span>
        ${opts.summary ? html`<span class="font-mono text-zinc-500 truncate">${opts.summary}</span>` : nothing}
      </div>
    </div>
  `;
}

/** Standard collapsible tool block with left border + expand/collapse toggle. */
export function renderCollapsibleTool(opts: {
  block: ToolBlockData;
  expanded: boolean;
  onToggle: () => void;
  summary: TemplateResult | string;
  detail?: TemplateResult;
  borderColor?: string;
  isError?: boolean;
}): TemplateResult {
  const border = opts.borderColor ?? "border-zinc-600";
  const images = opts.block.result?.content?.filter(
    (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
  ) ?? [];

  return html`
    <div class="mt-1 ml-2 border-l-2 ${border} pl-3">
      <button
        class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer truncate max-w-full"
        title="${opts.summary || opts.block.name}"
        @click=${opts.onToggle}
      >
        <span class="font-mono flex-shrink-0">${opts.expanded ? "▼" : "▶"}</span>
        <span class="font-semibold flex-shrink-0">${opts.block.name}</span>
        ${opts.isError ? html`<span class="text-red-400 ml-1 flex-shrink-0">error</span>` : nothing}
        ${opts.summary ? html`<span class="font-mono text-zinc-500 truncate">${opts.summary}</span>` : nothing}
      </button>
      ${!opts.expanded && images.length > 0 ? html`
        <div class="mt-1">
          ${images.map(
            (img) => html`<img src="data:${img.mimeType};base64,${img.data}" class="max-w-full max-h-96 rounded mt-1" alt="Tool result image" />`,
          )}
        </div>
      ` : nothing}
      ${opts.expanded && opts.detail ? opts.detail : nothing}
    </div>
  `;
}
