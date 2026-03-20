/**
 * Generic fallback tool renderer.
 *
 * Reproduces the current behavior: JSON args dump + raw result text.
 */

import { html, nothing } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";
import { getToolSummary, renderRunningTool, renderCollapsibleTool } from "./base.js";

export const genericRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const summary = getToolSummary(block.name, block.args);
    return renderRunningTool({ name: block.name, summary });
  },

  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void) {
    const summary = getToolSummary(block.name, block.args);

    const images = block.result?.content?.filter(
      (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
    ) ?? [];

    const resultText = block.result?.content
      ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 5000) ?? "";

    const detail = html`
      <div class="mt-1 text-xs">
        <div class="text-zinc-500 mb-1">Arguments:</div>
        <pre class="bg-zinc-900 rounded p-2 overflow-x-auto text-zinc-300 max-h-48 overflow-y-auto">${JSON.stringify(block.args, null, 2)}</pre>
        ${block.result ? html`
          <div class="text-zinc-500 mt-2 mb-1">Result${block.isError ? " (error)" : ""}:</div>
          ${images.map(
            (img) => html`<img src="data:${img.mimeType};base64,${img.data}" class="max-w-full max-h-96 rounded mt-1 mb-1" alt="Tool result image" />`,
          )}
          ${resultText ? html`
            <pre class="bg-zinc-900 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto ${block.isError ? "text-red-400" : "text-zinc-300"}">${resultText}</pre>
          ` : nothing}
        ` : nothing}
      </div>
    `;

    return renderCollapsibleTool({
      block,
      expanded,
      onToggle,
      summary,
      detail,
      isError: block.isError,
    });
  },
};
