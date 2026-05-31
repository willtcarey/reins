/**
 * GenericToolBlock — Lit component for rendering unknown tool calls.
 *
 * Collapsible left-border block showing JSON args dump + raw result text.
 * Used as the fallback for any tool that doesn't have a dedicated renderer.
 *
 * This is a pure presentational component — all data is passed as primitive
 * props by the renderer in generic.ts.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ToolResultImage } from "./types.js";
import { imageBlockSrc, isImageAttachmentBlock, isInlineImageBlock } from "../../models/chat-content.js";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { getToolSummary } from "../../models/tools/generic.js";

@customElement("generic-tool-block")
export class GenericToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Tool name (e.g. "read", "bash"). */
  @property()
  name = "";

  /** Short contextual summary derived from tool args. */
  @property()
  summary = "";

  /** Whether the tool result was an error. */
  @property({ type: Boolean })
  isError = false;

  /** Pre-serialised JSON of the tool arguments. */
  @property()
  argsJson = "";

  /** Concatenated text content from the tool result. */
  @property()
  resultText = "";

  /** Image attachments from the tool result. */
  @property({ attribute: false })
  images: ToolResultImage[] = [];

  @property({ attribute: false })
  sessionId = "";

  /** Whether a result exists (even if empty). */
  @property({ type: Boolean })
  hasResult = false;

  /** Whether to show the running spinner state. */
  @property({ type: Boolean })
  showSpinner = false;

  @state()
  private expanded = false;

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  override render() {
    if (this.showSpinner) {
      const border = "border-yellow-500";
      return html`
        <div class="mt-1 mb-1 ml-2 border-l-2 ${border} pl-3">
          <div class="flex items-center gap-2 text-xs text-zinc-400 truncate" title="${this.summary || this.name}">
            <span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>
            <span class="font-mono font-semibold flex-shrink-0">${this.name}</span>
            ${this.summary ? html`<span class="font-mono text-zinc-500 truncate">${this.summary}</span>` : nothing}
          </div>
        </div>
      `;
    }

    const border = "border-zinc-600";

    return html`
      <div class="mt-1 ml-2 border-l-2 ${border} pl-3">
        <button
          class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer truncate max-w-full"
          title="${this.summary || this.name}"
          @click=${this._toggle}
        >
          <span class="font-mono flex-shrink-0">${this.expanded ? "▼" : "▶"}</span>
          <span class="font-semibold flex-shrink-0">${this.name}</span>
          ${this.isError ? html`<span class="text-red-400 ml-1 flex-shrink-0">error</span>` : nothing}
          ${this.summary ? html`<span class="font-mono text-zinc-500 truncate">${this.summary}</span>` : nothing}
        </button>
        ${!this.expanded && this.images.length > 0 ? html`
          <div class="mt-1">
            ${this.images.map(
              (img) => html`<img src=${imageBlockSrc(this.sessionId, img)} class="max-w-full max-h-96 rounded mt-1" alt="Tool result image" />`,
            )}
          </div>
        ` : nothing}
        ${this.expanded ? html`
          <div class="mt-1 text-xs">
            <div class="text-zinc-500 mb-1">Arguments:</div>
            <pre class="bg-zinc-900 rounded p-2 overflow-x-auto text-zinc-300 max-h-48 overflow-y-auto">${this.argsJson}</pre>
            ${this.hasResult ? html`
              <div class="text-zinc-500 mt-2 mb-1">Result${this.isError ? " (error)" : ""}:</div>
              ${this.images.map(
                (img) => html`<img src=${imageBlockSrc(this.sessionId, img)} class="max-w-full max-h-96 rounded mt-1 mb-1" alt="Tool result image" />`,
              )}
              ${this.resultText ? html`
                <pre class="bg-zinc-900 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto ${this.isError ? "text-red-400" : "text-zinc-300"}">${this.resultText}</pre>
              ` : nothing}
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "generic-tool-block": GenericToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractImages(block: ToolBlockData): ToolResultImage[] {
  return block.result?.content?.filter(
    (c): c is ToolResultImage => isInlineImageBlock(c) || isImageAttachmentBlock(c),
  ) ?? [];
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
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const summary = getToolSummary(block.name, block.args);
    const images = isRunning ? [] : extractImages(block);
    const resultText = isRunning ? "" : extractResultText(block);
    return html`<generic-tool-block
      .name=${block.name}
      .summary=${summary}
      .isError=${!isRunning && !!block.isError}
      .argsJson=${isRunning ? "" : JSON.stringify(block.args, null, 2)}
      .resultText=${resultText}
      .images=${images}
      .sessionId=${block.sessionId ?? ""}
      .hasResult=${!isRunning && !!block.result}
      .showSpinner=${isRunning}
    ></generic-tool-block>`;
  },
};
