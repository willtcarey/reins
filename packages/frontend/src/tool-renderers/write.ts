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

/** Extract and optionally truncate the content from a Write tool block. */
export function getWriteContent(block: ToolBlockData): string {
  const content = block.args?.content;
  if (!content || typeof content !== "string") return "";
  return content.length > 5000 ? content.slice(0, 5000) + "\n…(truncated)" : content;
}

// ---------------------------------------------------------------------------
// Renderer — delegates visual output to <write-tool-block> component
// ---------------------------------------------------------------------------

// Side-effect import: registers <write-tool-block> custom element
import "./write-tool-block.js";

export const writeRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const path = getWriteSummary(block);
    const content = getWriteContent(block);
    const { lines: lineCount } = getWriteInfo(block);
    const isError = !!block.isError;
    return html`<write-tool-block
      .path=${path}
      .content=${content}
      .lineCount=${lineCount}
      .isError=${isError}
      .showSpinner=${true}
    ></write-tool-block>`;
  },

  renderDone(block: ToolBlockData) {
    const path = getWriteSummary(block);
    const content = getWriteContent(block);
    const { lines: lineCount } = getWriteInfo(block);
    const isError = !!block.isError;
    return html`<write-tool-block
      .path=${path}
      .content=${content}
      .lineCount=${lineCount}
      .isError=${isError}
    ></write-tool-block>`;
  },
};
