/**
 * BashToolBlock — Lit component for rendering Bash tool calls.
 *
 * Terminal-style block: command is always visible with a `$` prompt.
 * While it runs, the output so far shows below in a box of fixed height,
 * following its tail; when it is done, the box animates closed, and clicking
 * expands to reveal the output.
 *
 * This is a pure presentational component — all data is passed in as
 * primitive props. It has no dependency on ToolBlockData or helper functions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ChatImageBlock } from "../../models/chat-content.js";
import type { ToolRenderer } from "./types.js";
import { ringSpinnerIcon } from "../../ui/icons.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { parseCommandSegments } from "../../models/tools/bash-command-parser.js";
import { getBashCommand, getBashExitInfo, getBashOutput } from "../../models/tools/bash.js";
import { toolResultImages } from "../../models/tools/images.js";
import "./tool-result-images.js";

/** How long a command runs before its output opens. */
const LIVE_OUTPUT_DELAY_MS = 400;
/** The output's open and close animation (`duration-200`), with a margin. */
const OUTPUT_TRANSITION_MS = 250;

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

  @state()
  private expanded = false;

  /** The running command's output is shown: once it has run for `LIVE_OUTPUT_DELAY_MS`. */
  @state()
  private live = false;

  /** The output is closing (its rows animate to nothing), from the live view or from expanded. */
  @state()
  private closing: "live" | "expanded" | null = null;

  /** Whether the running output keeps its tail in view: until the user scrolls up from it. */
  private followTail = true;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private closingTimer: ReturnType<typeof setTimeout> | undefined;

  private _toggle = () => {
    if (this.expanded) this.close("expanded");
    this.expanded = !this.expanded;
  };

  private _onOutputScroll = (event: Event) => {
    if (!this.showSpinner || !(event.currentTarget instanceof HTMLElement)) return;
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    this.followTail = scrollTop + clientHeight >= scrollHeight - 8;
  };

  /** Keeps the output rendered while it animates closed, then drops it: a long output costs nothing collapsed. */
  private close(from: "live" | "expanded") {
    clearTimeout(this.closingTimer);
    this.closing = from;
    this.closingTimer = setTimeout(() => { this.closing = null; }, OUTPUT_TRANSITION_MS);
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("showSpinner")) return;
    clearTimeout(this.liveTimer);
    if (this.showSpinner) {
      // A quick command ends before its output would open: no box flashes open and shut.
      this.liveTimer = setTimeout(() => { this.live = true; }, LIVE_OUTPUT_DELAY_MS);
    } else if (this.live) {
      this.live = false;
      if (!this.expanded) this.close("live");
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.liveTimer);
    clearTimeout(this.closingTimer);
  }

  override updated() {
    if (!this.showSpinner || !this.followTail) return;
    const output = this.querySelector<HTMLElement>("[data-role=bash-output]");
    if (output) output.scrollTop = output.scrollHeight;
  }

  override render() {
    const { command, isError, output, images, showSpinner, sessionId } = this;

    const borderColor = isError
      ? "border-red-500/60"
      : showSpinner
        ? "border-yellow-500/60"
        : "border-zinc-700";

    const hasOutput = !!output.trim();
    const clickable = !showSpinner && (hasOutput || images.length > 0);
    const liveView = (showSpinner && this.live) || this.closing === "live";
    const open = (showSpinner && this.live) || this.expanded;

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg bg-zinc-950 border ${borderColor} overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Command area -->
        <div class="px-3 py-2 flex items-start gap-2">
          ${showSpinner
            ? ringSpinnerIcon("inline-block w-3 h-3 mt-0.5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0")
            : nothing}
          <pre class="text-xs font-mono whitespace-pre-wrap break-words m-0 flex-1 min-w-0"><span class="text-green-500 select-none">$ </span>${renderCommandSegments(command)}</pre>
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0 self-start">error</span>`
            : nothing}
        </div>

        <!-- Output area: while running (a fixed height, so it does not grow line by line), or when expanded.
             Its rows animate open from nothing and closed to nothing. -->
        ${hasOutput && (open || this.closing) ? html`
          <div class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr] starting:grid-rows-[0fr]" : "grid-rows-[0fr]"}">
            <div class="min-h-0 overflow-hidden">
              <div class="border-t border-zinc-800">
                <pre data-role="bash-output" @scroll=${this._onOutputScroll} class="px-3 py-2 text-xs font-mono ${isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 ${liveView ? "h-32" : "max-h-64"} overflow-y-auto">${output}</pre>
              </div>
            </div>
          </div>
        ` : nothing}

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
    ></bash-tool-block>`;
  },
};
