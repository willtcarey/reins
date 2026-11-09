/**
 * BashToolBlock — Lit component for rendering Bash tool calls.
 *
 * Terminal-style block: the command with a `$` prompt, which a spinner replaces
 * while it runs (in the prompt's place, so the command does not move when it
 * ends). A long command shows its newest lines while it is written and its first
 * ones after. While it runs, its newest output lines show below (`<live-lines>`);
 * clicking expands to all of the command and output, also while it runs.
 *
 * This is a pure presentational component — all data is passed in as
 * primitive props. It has no dependency on ToolBlockData or helper functions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ChatImageBlock } from "../../models/chat-content.js";
import type { ToolRenderer } from "./types.js";
import { ringSpinnerIcon } from "../../ui/icons.js";
import "./live-lines.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { parseCommandSegments } from "../../models/tools/bash-command-parser.js";
import { COMMAND_LINES, getBashCommand, getBashExitInfo, getBashOutput, shownCommand } from "../../models/tools/bash.js";
import { toolResultImages } from "../../models/tools/images.js";
import "./tool-result-images.js";

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
  images: ChatImageBlock[] = [];

  @property({ attribute: false })
  sessionId = "";

  @property({ type: Boolean })
  showSpinner = false;

  /** Its command is still being written: its newest lines show. */
  @property({ type: Boolean })
  writing = false;

  @state()
  private expanded = false;

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  private _renderLine = (line: string, _index: number, preview: boolean) => html`<div class="px-2 leading-4 ${preview ? "truncate whitespace-pre" : "whitespace-pre-wrap break-words"}">${line || " "}</div>`;

  override render() {
    const { command, isError, output, images, showSpinner, sessionId, writing } = this;

    const borderColor = isError
      ? "border-red-500/60"
      : showSpinner
        ? "border-yellow-500/60"
        : "border-zinc-700";

    const hasOutput = !!output.trim();
    const longCommand = command.split("\n").length > COMMAND_LINES;
    const clickable = hasOutput || longCommand || (!showSpinner && images.length > 0);
    const shown = shownCommand(command, { writing, expanded: this.expanded });
    const more = (count: number, where: string) => html`<div class="text-[10px] leading-4 text-zinc-600 select-none">… ${count} ${where}</div>`;
    // At most COMMAND_LINES rows, also when its lines wrap: while it is written the box keeps its end in view.
    const box = this.expanded ? "max-h-96 overflow-auto" : `max-h-40 overflow-hidden ${writing ? "flex flex-col justify-end" : ""}`;

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg bg-zinc-950 border ${borderColor} overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Command area -->
        <div class="px-3 py-2 flex items-start gap-2">
          <div class="flex-1 min-w-0">
            ${shown.before ? more(shown.before, shown.before === 1 ? "earlier line" : "earlier lines") : nothing}
            <div class=${box}>
              <pre class="text-xs leading-4 font-mono whitespace-pre-wrap break-words m-0 min-w-0"><span class="inline-flex h-4 w-[2ch] items-center align-top select-none text-green-500">${showSpinner
                ? ringSpinnerIcon("inline-block w-2.5 h-2.5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin")
                : "$"}</span>${renderCommandSegments(shown.text)}</pre>
            </div>
            ${shown.after ? more(shown.after, shown.after === 1 ? "more line" : "more lines") : nothing}
          </div>
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0 self-start">error</span>`
            : nothing}
        </div>

        <!-- Output: its newest lines while it runs, all of it when expanded -->
        ${hasOutput ? html`<live-lines
          class=${isError ? "text-red-400" : "text-zinc-400"}
          .lines=${output.replace(/\n$/, "").split("\n")}
          .renderLine=${this._renderLine}
          .preview=${showSpinner ? "newest" : null}
          .expanded=${this.expanded}
        ></live-lines>` : nothing}

        <!-- Images (show when expanded, or always if no text output) -->
        ${images.length > 0 && (this.expanded || !hasOutput) ? html`
          <div class="border-t border-zinc-800 p-2">
            <tool-result-images .images=${images} .sessionId=${sessionId} .maxHeight=${"max-h-96"}></tool-result-images>
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
    const output = getBashOutput(block);
    const images = isRunning ? [] : toolResultImages(block);
    return html`<bash-tool-block
      .command=${command}
      .isError=${isError}
      .output=${output}
      .images=${images}
      .sessionId=${block.sessionId ?? ""}
      .showSpinner=${isRunning}
      .writing=${!!block.partialArgs}
    ></bash-tool-block>`;
  },
};
