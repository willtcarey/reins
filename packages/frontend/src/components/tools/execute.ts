/**
 * ExecuteToolBlock — Lit component for rendering Execute tool calls.
 *
 * Terminal-style block: JS code is always visible with a `>` prompt,
 * syntax-highlighted via Shiki. Output so far shows below while it runs; once
 * it is done, clicking expands to reveal the output. Images the script gave
 * (`image()`) are shown below the code without expanding, as read's are; clicking one opens it.
 *
 * This is a pure presentational component — all data is passed in as
 * primitive props. It has no dependency on ToolBlockData or helper functions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LazyHighlightController } from "../../controllers/lazy-highlight-controller.js";
import { escapeHtml } from "../../models/changes/diff-utils.js";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { ringSpinnerIcon, toolLogoIcon } from "../../ui/icons.js";
import type { ChatImageBlock } from "../../models/chat-content.js";
import { toolResultImages } from "../../models/tools/images.js";
import "./tool-result-images.js";
import {
  getExecuteCode,
  getExecuteExitInfo,
  getExecuteOutput,
} from "../../models/tools/execute.js";

@customElement("execute-tool-block")
export class ExecuteToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _hl = new LazyHighlightController(this, () => {
    if (!this.code) return null;
    const lines = this.code.split("\n");
    return {
      path: "script.js",
      hunk: {
        header: "",
        lines: lines.map((text, i) => ({
          type: "context" as const,
          text,
          newLine: i + 1,
        })),
      },
    };
  });

  @property({ attribute: false })
  code = "";

  @property({ type: Boolean })
  isError = false;

  @property({ attribute: false })
  output = "";

  @property({ attribute: false })
  images: ChatImageBlock[] = [];

  @property({ attribute: false })
  sessionId = "";

  @property({ type: Boolean })
  showSpinner = false;

  @state()
  private expanded = false;

  override connectedCallback() {
    super.connectedCallback();
    this._hl.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._hl.disconnect();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("code")) {
      this._hl.update();
    }
  }

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._hl.getLineHtml(index);
    return highlighted ? unsafeHTML(highlighted) : escapeHtml(text);
  }

  private _renderCodeLines() {
    const lines = this.code.split("\n");
    return lines.map((line, i) => {
      return html`<div class="whitespace-pre-wrap break-words">${this._renderHighlightedLine(i, line)}</div>`;
    });
  }

  override render() {
    const { isError, output, showSpinner } = this;

    const borderColor = isError
      ? "border-cyan-500/60"
      : showSpinner
        ? "border-cyan-500/60"
        : "border-zinc-700";

    const hasOutput = !!output.trim();
    const clickable = !showSpinner && hasOutput;

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg bg-zinc-900 border ${borderColor} overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Code area -->
        <div class="px-3 py-2 flex items-start gap-2">
          ${showSpinner
            ? ringSpinnerIcon("inline-block w-3 h-3 mt-0.5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin flex-shrink-0")
            : toolLogoIcon("w-3 h-3 mt-0.5 flex-shrink-0")}
          <div class="text-xs font-mono flex-1 min-w-0">${this._renderCodeLines()}</div>
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0 self-start">error</span>`
            : nothing}
        </div>

        ${!showSpinner && this.images.length > 0 ? html`
          <div class="border-t border-zinc-800 p-2">
            <tool-result-images .images=${this.images} .sessionId=${this.sessionId} .maxHeight=${"max-h-64"}></tool-result-images>
          </div>
        ` : nothing}

        <!-- Output area (while running, or when expanded) -->
        ${(showSpinner || this.expanded) && hasOutput ? html`
          <div class="border-t border-zinc-800">
            <pre class="px-3 py-2 text-xs font-mono ${isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">${output}</pre>
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "execute-tool-block": ExecuteToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <execute-tool-block>
// ---------------------------------------------------------------------------

export const executeRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const code = getExecuteCode(block);
    const { isError } = getExecuteExitInfo(block);
    const output = getExecuteOutput(block);
    const images = isRunning ? [] : toolResultImages(block);
    return html`<execute-tool-block
      .code=${code}
      .isError=${isError}
      .output=${output}
      .images=${images}
      .sessionId=${block.sessionId ?? ""}
      .showSpinner=${isRunning}
    ></execute-tool-block>`;
  },
};
