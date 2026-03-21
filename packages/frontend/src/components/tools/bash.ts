/**
 * BashToolBlock — Lit component for rendering Bash tool calls.
 *
 * Terminal-style block: command is always visible with a `$` prompt.
 * Clicking expands to reveal the output below.
 *
 * This is a pure presentational component — all data is passed in as
 * primitive props. It has no dependency on ToolBlockData or helper functions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ToolResultImage } from "./types.js";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { parseCommandSegments } from "../../models/tools/bash-command-parser.js";
import { getBashCommand, getBashExitInfo, getBashOutput, getBashImages } from "../../models/tools/bash.js";

function renderCommandSegments(command: string) {
  const segments = parseCommandSegments(command);
  return segments.map((seg) => {
    switch (seg.type) {
      case "command":
        return html`<span class="text-zinc-200 font-semibold">${seg.text}</span>`;
      case "operator":
        return html`<span class="text-blue-400">${seg.text}</span>`;
      case "args":
        return html`<span class="text-zinc-300">${seg.text}</span>`;
    }
  });
}

@customElement("bash-tool-block")
export class BashToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property()
  command = "";

  @property({ type: Boolean })
  isError = false;

  @property()
  output = "";

  @property({ attribute: false })
  images: ToolResultImage[] = [];

  @property({ type: Boolean })
  showSpinner = false;

  @state()
  private expanded = false;

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  override render() {
    const { command, isError, output, images, showSpinner } = this;

    const borderColor = isError
      ? "border-red-500/60"
      : showSpinner
        ? "border-yellow-500/60"
        : "border-zinc-700";

    const hasOutput = !!output.trim();
    const clickable = !showSpinner && (hasOutput || images.length > 0);

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg bg-zinc-950 border ${borderColor} overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Command area -->
        <div class="px-3 py-2 flex items-start gap-2">
          ${showSpinner
            ? html`<span class="inline-block w-3 h-3 mt-0.5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : nothing}
          <pre class="text-xs font-mono whitespace-pre-wrap break-words m-0 flex-1 min-w-0"><span class="text-green-500 select-none">$ </span>${renderCommandSegments(command)}</pre>
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0 self-start">error</span>`
            : nothing}
        </div>

        <!-- Output area (only when expanded) -->
        ${this.expanded && hasOutput ? html`
          <div class="border-t border-zinc-800">
            <pre class="px-3 py-2 text-xs font-mono ${isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">${output}</pre>
          </div>
        ` : nothing}

        <!-- Images (show when expanded, or always if no text output) -->
        ${images.length > 0 && (this.expanded || !hasOutput) ? html`
          <div class="border-t border-zinc-800 p-2">
            ${images.map(
              (img) => html`<img src="data:${img.mimeType};base64,${img.data}" class="max-w-full max-h-96 rounded mt-1" alt="Tool result image" />`,
            )}
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "bash-tool-block": BashToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <bash-tool-block>
// ---------------------------------------------------------------------------

export const bashRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const command = getBashCommand(block);
    const { isError } = getBashExitInfo(block);
    const output = isRunning ? "" : getBashOutput(block);
    const images = isRunning ? [] : getBashImages(block);
    return html`<bash-tool-block
      .command=${command}
      .isError=${isError}
      .output=${output}
      .images=${images}
      .showSpinner=${isRunning}
    ></bash-tool-block>`;
  },
};
