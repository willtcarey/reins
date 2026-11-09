/**
 * LiveLines — the lines of a tool block's output or content, below its header.
 *
 * Collapsed, it shows a preview of `PREVIEW_LINES`: the newest lines while
 * they still grow (a running command, a file being written), or the first
 * ones once they are settled; a growing preview slides open, and closed when
 * the lines stop growing. Expanded, it shows every line in a scroll box
 * that follows the end while they grow, until the user scrolls up in it.
 * The block owns its header, its expansion and how each line looks.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { TailFollowController } from "../../controllers/tail-follow-controller.js";

export const PREVIEW_LINES = 4;
/** The preview's open and close animation (`duration-200`), with a margin. */
const CLOSE_MS = 250;

@customElement("live-lines")
export class LiveLines<T = string> extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  lines: readonly T[] = [];

  /** One line as a row; `index` is its place in `lines`, `preview` whether it is in the collapsed preview,
   * where a row must not wrap. */
  @property({ attribute: false })
  renderLine: (line: T, index: number, preview: boolean) => unknown = (line) => String(line);

  /** What shows collapsed: the newest lines while they grow, the first ones, or nothing. */
  @property({ attribute: false })
  preview: "newest" | "first" | null = null;

  @property({ type: Boolean })
  expanded = false;

  /** The expanded box's height limit (a Tailwind class; empty for none). */
  @property({ attribute: false })
  maxHeight = "max-h-64";

  /** Rows wrap their text; otherwise they keep one row each and the box scrolls sideways. */
  @property({ type: Boolean })
  wrap = true;

  /** The growing preview is sliding closed: its lines stopped growing, and nothing else shows in its place. */
  @state()
  private closing = false;

  private closingTimer: ReturnType<typeof setTimeout> | undefined;
  private tail = new TailFollowController(this, "[data-role=live-lines]", () => this.expanded && this.preview === "newest");

  override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("preview")) return;
    clearTimeout(this.closingTimer);
    this.closing = changed.get("preview") === "newest" && this.preview === null && !this.expanded;
    if (this.closing) this.closingTimer = setTimeout(() => { this.closing = false; }, CLOSE_MS);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.closingTimer);
  }

  override render() {
    const { lines } = this;
    if (lines.length === 0 || (!this.expanded && !this.preview && !this.closing)) return nothing;
    const width = this.wrap ? "" : "w-fit min-w-full";

    if (this.expanded) {
      return html`<div data-role="live-lines" @scroll=${this.tail.onScroll} class="border-t border-zinc-800 px-1 py-1 text-xs font-mono overflow-auto ${this.maxHeight}">
        <div class=${width}>${lines.map((line, index) => this.renderLine(line, index, false))}</div>
      </div>`;
    }

    const growing = this.preview === "newest" || this.closing;
    const start = growing ? Math.max(0, lines.length - PREVIEW_LINES) : 0;
    const shown = lines.slice(start, start + PREVIEW_LINES);
    const more = html`<div class="px-2 leading-4 text-zinc-700">…</div>`;
    // Preview rows never wrap (a long line is cut at the edge), so a growing preview grows one row per line up to
    // its mark and PREVIEW_LINES rows, then keeps that height: rows that wrap would change it with every line.
    const preview = html`<div class="border-t border-zinc-800 px-1 py-1 text-xs font-mono overflow-hidden">
      <div class="w-fit min-w-full">
        ${start > 0 ? more : nothing}
        ${shown.map((line, index) => this.renderLine(line, start + index, true))}
        ${start + shown.length < lines.length ? more : nothing}
      </div>
    </div>`;
    if (!growing) return preview;
    // A growing preview slides open from nothing and closed to nothing; a settled one (history) just shows.
    return html`<div class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${this.closing ? "grid-rows-[0fr]" : "grid-rows-[1fr] starting:grid-rows-[0fr]"}">
      <div class="min-h-0 overflow-hidden">${preview}</div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-lines": LiveLines;
  }
}
