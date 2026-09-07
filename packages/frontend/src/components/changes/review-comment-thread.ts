import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { InlineReviewPlacement } from "../../controllers/inline-review-controller.js";

@customElement("review-comment-thread")
export class ReviewCommentThread extends LitElement {
  override createRenderRoot() { return this; }

  @property({ attribute: false }) placement: InlineReviewPlacement | null = null;
  private focusedComposer = false;

  override updated() {
    if (this.placement?.composer && !this.focusedComposer) {
      this.focusedComposer = true;
      this.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else if (!this.placement?.composer) this.focusedComposer = false;
  }

  private updateDraft(event: Event) {
    const input = event.currentTarget;
    const placement = this.placement;
    if (!hasValue(input) || !placement?.composer) return;
    placement.composer.input(input.value);
    // Keep only the mounted annotation's presentation current. The controller
    // retains the durable draft without forcing Pierre to replace this element.
    this.placement = {
      ...placement,
      composer: { ...placement.composer, body: input.value, error: null },
    };
  }

  private save(event: Event) {
    event.preventDefault();
    void this.placement?.composer?.save();
  }

  private cancel() {
    const composer = this.placement?.composer;
    if (composer?.body.trim() && typeof confirm === "function" && !confirm("Discard this inline comment draft?")) return;
    composer?.cancel();
  }

  private handleComposerKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.cancel();
  }

  override render() {
    const placement = this.placement;
    if (!placement) return nothing;
    const rangeLabel = reviewRangeLabel(placement.range.side, placement.range.startLine, placement.range.endLine);
    return html`
      <section class="min-w-0 border-y border-zinc-700 bg-zinc-900/95 p-3 font-sans text-sm text-zinc-200"
        aria-label=${`Inline comments for ${rangeLabel}`} @pointerdown=${(event: PointerEvent) => event.stopPropagation()}>
        <p class="mb-2 text-xs font-medium text-zinc-400">${rangeLabel}</p>
        ${placement.comments.map((comment) => html`
          <article class="mb-3 rounded-md border border-zinc-700 bg-zinc-800/80 p-3">
            <header class="mb-2"><strong class="text-xs text-zinc-300">${comment.author}</strong></header>
            <p class="whitespace-pre-wrap break-words text-sm text-zinc-100">${comment.body}</p>
          </article>`)}
        ${placement.composer ? html`
          <form class="rounded-md border border-sky-800/80 bg-zinc-800 p-3" @submit=${this.save}>
            <label class="mb-2 block text-xs font-medium text-zinc-300" for=${`inline-comment-${placement.id}`}>${`Comment on ${rangeLabel}`}</label>
            <textarea id=${`inline-comment-${placement.id}`}
              class="min-h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-950 p-2 text-base text-zinc-100 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
              .value=${placement.composer.body} ?disabled=${placement.composer.saving}
              aria-describedby=${placement.composer.error ? `inline-comment-error-${placement.id}` : nothing}
              @input=${this.updateDraft} @keydown=${this.handleComposerKeydown}></textarea>
            ${placement.composer.error ? html`<p id=${`inline-comment-error-${placement.id}`} class="mt-2 text-xs text-red-300" role="alert">${placement.composer.error}</p>` : nothing}
            <div class="mt-3 flex flex-wrap justify-end gap-2">
              <button type="button" class="min-h-11 rounded px-4 text-sm text-zinc-300 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400"
                aria-label="Cancel comment" ?disabled=${placement.composer.saving} @click=${this.cancel}>Cancel</button>
              <button type="submit" class="min-h-11 rounded bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                aria-label="Save comment" ?disabled=${placement.composer.saving}>${placement.composer.saving ? "Saving…" : "Save comment"}</button>
            </div>
          </form>` : nothing}
      </section>`;
  }
}

function reviewRangeLabel(side: "old" | "new", startLine: number, endLine: number): string {
  return startLine === endLine ? `${side} line ${startLine}` : `${side} lines ${startLine}–${endLine}`;
}
function hasValue(value: unknown): value is { value: string } {
  return typeof value === "object" && value !== null && "value" in value && typeof value.value === "string";
}
declare global { interface HTMLElementTagNameMap { "review-comment-thread": ReviewCommentThread; } }
