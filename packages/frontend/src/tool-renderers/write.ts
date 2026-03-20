/**
 * Write tool renderer.
 *
 * Card-style block (matching edit-tool-block) with file path + line count badge.
 * When expanded, shows syntax-highlighted content preview.
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (tested without DOM)
// ---------------------------------------------------------------------------

/** Extract the file path from a Write tool block's args. */
export function getWriteSummary(block: ToolBlockData): string {
  return block.args?.path ?? "";
}

/** Get line count of content being written. */
export function getWriteInfo(block: ToolBlockData): { lines: number } {
  const content = block.args?.content;
  if (!content || typeof content !== "string") return { lines: 0 };
  if (content === "") return { lines: 0 };
  return { lines: content.split("\n").length };
}

// ---------------------------------------------------------------------------
// Renderer — delegates visual output to <write-tool-block> component
// ---------------------------------------------------------------------------

// Side-effect import: registers <write-tool-block> custom element
import "./write-tool-block.js";

export const writeRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    return html`<write-tool-block .block=${block} .showSpinner=${true}></write-tool-block>`;
  },

  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void) {
    return html`<write-tool-block .block=${block} .expanded=${expanded} .onToggle=${onToggle}></write-tool-block>`;
  },
};
