/**
 * Bash tool renderer.
 *
 * Terminal-style block: command is always visible with a `$` prompt.
 * Expanding reveals the output below. Rendering is handled by the
 * `<bash-tool-block>` Lit component (./bash-tool-block.ts).
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";
export type { CommandSegment } from "./bash-command-parser.js";
export { parseCommandSegments } from "./bash-command-parser.js";

// Side-effect import: registers <bash-tool-block> custom element
import "./bash-tool-block.js";
import type { ToolResultImage } from "./types.js";

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

/** Extract image content items from a Bash tool block result. */
export function getBashImages(block: ToolBlockData): ToolResultImage[] {
  return block.result?.content?.filter(
    (c): c is ToolResultImage => c.type === "image",
  ) ?? [];
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <bash-tool-block>
// ---------------------------------------------------------------------------

export const bashRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const command = getBashCommand(block);
    return html`<bash-tool-block
      .command=${command}
      .isError=${false}
      .output=${""}
      .images=${[]}
      .showSpinner=${true}
    ></bash-tool-block>`;
  },

  renderDone(block: ToolBlockData) {
    const command = getBashCommand(block);
    const { isError } = getBashExitInfo(block);
    const output = getBashOutput(block);
    const images = getBashImages(block);
    return html`<bash-tool-block
      .command=${command}
      .isError=${isError}
      .output=${output}
      .images=${images}
      .showSpinner=${false}
    ></bash-tool-block>`;
  },
};
