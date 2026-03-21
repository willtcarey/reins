/**
 * Generic fallback tool renderer.
 *
 * Used for any tool that doesn't have a dedicated renderer.
 * Displays JSON args dump + raw result text in a collapsible block.
 * Rendering is handled by the `<generic-tool-block>` Lit component
 * (./generic-tool-block.ts).
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";
import type { ToolResultImage } from "./types.js";

// Side-effect import: registers <generic-tool-block> custom element
import "./generic-tool-block.js";

// ---------------------------------------------------------------------------
// Pure logic helpers
// ---------------------------------------------------------------------------

/**
 * Return a short contextual summary for a tool call based on its args.
 *
 * Shows the first non-empty string arg value, truncated to 120 chars.
 */
export function getToolSummary(_name: string, args: Record<string, any> | undefined): string {
  if (!args) return "";
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 120 ? v.slice(0, 117) + "…" : v;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractImages(block: ToolBlockData): ToolResultImage[] {
  return (
    block.result?.content?.filter(
      (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
    ) ?? []
  );
}

function extractResultText(block: ToolBlockData): string {
  return (
    block.result?.content
      ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 5000) ?? ""
  );
}

// ---------------------------------------------------------------------------
// Generic renderer — delegates visual output to <generic-tool-block> component
// ---------------------------------------------------------------------------

export const genericRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const summary = getToolSummary(block.name, block.args);
    return html`<generic-tool-block
      .name=${block.name}
      .summary=${summary}
      .isError=${false}
      .argsJson=${""}
      .resultText=${""}
      .images=${[]}
      .hasResult=${false}
      .showSpinner=${true}
    ></generic-tool-block>`;
  },

  renderDone(block: ToolBlockData) {
    const summary = getToolSummary(block.name, block.args);
    const images = extractImages(block);
    const resultText = extractResultText(block);
    return html`<generic-tool-block
      .name=${block.name}
      .summary=${summary}
      .isError=${!!block.isError}
      .argsJson=${JSON.stringify(block.args, null, 2)}
      .resultText=${resultText}
      .images=${images}
      .hasResult=${!!block.result}
      .showSpinner=${false}
    ></generic-tool-block>`;
  },
};
