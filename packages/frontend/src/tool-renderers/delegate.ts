/**
 * delegate tool renderer.
 *
 * Card-style layout that visually distinguishes delegated work from
 * regular tool calls. Shows truncated prompt when collapsed,
 * full prompt + result summary when expanded. Rendering is handled by
 * the `<delegate-tool-block>` Lit component (./delegate-tool-block.ts).
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";

// Side-effect import: registers <delegate-tool-block> custom element
import "./delegate-tool-block.js";

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
// Internal helpers
// ---------------------------------------------------------------------------

function extractResultText(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to component
// ---------------------------------------------------------------------------

export const delegateRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const summary = getDelegateSummary(block);
    const { prompt } = getDelegateDetail(block);
    return html`<delegate-tool-block
      .summary=${summary}
      .prompt=${prompt}
      .isError=${false}
      .resultText=${""}
      .showSpinner=${true}
    ></delegate-tool-block>`;
  },

  renderDone(block: ToolBlockData) {
    const summary = getDelegateSummary(block);
    const { prompt } = getDelegateDetail(block);
    const isError = !!block.isError;
    const resultText = extractResultText(block);
    return html`<delegate-tool-block
      .summary=${summary}
      .prompt=${prompt}
      .isError=${isError}
      .resultText=${resultText}
      .showSpinner=${false}
    ></delegate-tool-block>`;
  },
};
