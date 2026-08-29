import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ReviewComments } from "../../models/changes/review-comments.js";

@customElement("review-comment-thread")
export class ReviewCommentThread extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) comments: ReviewComments | null = null;
  @property() fileId = "";
  @property({ attribute: "data-placement-id" }) placementId = "";

  private unsubscribe: (() => void) | null = null;
  private focusedComposer = false;

  override connectedCallback() {
    super.connectedCallback();
    this.subscribe();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("comments")) this.subscribe();
  }

  override updated() {
    const placement = this.placement();
    if (placement?.composer && !this.focusedComposer) {
      this.focusedComposer = true;
      this.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else if (!placement?.composer) {
      this.focusedComposer = false;
    }
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.disconnectedCallback();
  }

  private subscribe() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.isConnected || !this.comments) return;
    this.unsubscribe = this.comments.subscribe((change) => {
      if (change.fileId === this.fileId) this.requestUpdate();
    });
  }

  private placement() {
    return this.comments?.project(this.fileId).placements.find(
      (placement) => placement.id === this.placementId,
    ) ?? null;
  }

  private updateDraft(event: Event) {
    const input = event.currentTarget;
    if (!hasValue(input)) return;
    this.comments?.dispatch({ type: "update-draft", fileId: this.fileId, body: input.value });
  }

  private save(event: Event) {
    event.preventDefault();
    this.comments?.dispatch({ type: "save-comment", fileId: this.fileId });
  }

  private cancel() {
    const composer = this.placement()?.composer;
    if (composer?.body.trim() && typeof confirm === "function" && !confirm("Discard this inline comment draft?")) {
      return;
    }
    this.comments?.dispatch({ type: "cancel-composer", fileId: this.fileId });
  }

  private handleComposerKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.cancel();
  }

  private deleteComment(commentId: string) {
    this.comments?.dispatch({ type: "delete-comment", fileId: this.fileId, commentId });
  }

  override render() {
    const placement = this.placement();
    if (!placement) return nothing;
    const rangeLabel = reviewRangeLabel(placement.range.side, placement.range.startLine, placement.range.endLine);

    return html`
      <section
        class="min-w-0 border-y border-zinc-700 bg-zinc-900/95 p-3 font-sans text-sm text-zinc-200"
        aria-label=${`Inline comments for ${rangeLabel}`}
        @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
      >
        <p class="mb-2 text-xs font-medium text-zinc-400">${rangeLabel}</p>
        ${placement.comments.map((comment) => html`
          <article class="mb-3 rounded-md border border-zinc-700 bg-zinc-800/80 p-3">
            <header class="mb-2 flex items-center justify-between gap-3">
              <strong class="text-xs text-zinc-300">${comment.author}</strong>
              <button
                type="button"
                class="inline-flex min-h-11 items-center rounded px-3 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-red-300 focus-visible:outline-2 focus-visible:outline-sky-400"
                aria-label="Delete comment"
                @click=${() => this.deleteComment(comment.id)}
              >Delete</button>
            </header>
            <p class="whitespace-pre-wrap break-words text-sm text-zinc-100">${comment.body}</p>
          </article>
        `)}
        ${placement.composer ? html`
          <form class="rounded-md border border-sky-800/80 bg-zinc-800 p-3" @submit=${this.save}>
            <label class="mb-2 block text-xs font-medium text-zinc-300" for=${`inline-comment-${this.placementId}`}>
              ${`Comment on ${rangeLabel}`}
            </label>
            <textarea
              id=${`inline-comment-${this.placementId}`}
              class="min-h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-950 p-2 text-base text-zinc-100 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
              .value=${placement.composer.body}
              aria-describedby=${placement.composer.error ? `inline-comment-error-${this.placementId}` : nothing}
              @input=${this.updateDraft}
              @keydown=${this.handleComposerKeydown}
            ></textarea>
            ${placement.composer.error ? html`
              <p id=${`inline-comment-error-${this.placementId}`} class="mt-2 text-xs text-red-300" role="alert">
                ${placement.composer.error}
              </p>
            ` : nothing}
            <div class="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                class="min-h-11 rounded px-4 text-sm text-zinc-300 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400"
                aria-label="Cancel comment"
                @click=${this.cancel}
              >Cancel</button>
              <button
                type="submit"
                class="min-h-11 rounded bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                aria-label="Save comment"
              >Save comment</button>
            </div>
          </form>
        ` : nothing}
      </section>
    `;
  }
}

function reviewRangeLabel(side: "old" | "new", startLine: number, endLine: number): string {
  const sideLabel = side === "old" ? "old" : "new";
  return startLine === endLine
    ? `${sideLabel} line ${startLine}`
    : `${sideLabel} lines ${startLine}–${endLine}`;
}

function hasValue(value: unknown): value is { value: string } {
  return typeof value === "object" && value !== null && "value" in value && typeof value.value === "string";
}

declare global {
  interface HTMLElementTagNameMap {
    "review-comment-thread": ReviewCommentThread;
  }
}
