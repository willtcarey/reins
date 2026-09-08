import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { InlineReviewPlacement } from "../../controllers/inline-review-controller.js";
import { conversationIcon, spinnerIcon, trashIcon } from "../icons.js";

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
    return html`
      <section class="min-w-0 border-y border-zinc-700 bg-zinc-900/95 p-3 font-sans text-sm text-zinc-200"
        aria-label="Inline review comments" @pointerdown=${(event: PointerEvent) => event.stopPropagation()}>
        ${placement.comments.map((comment) => html`
          <article class="mb-3 border-b border-zinc-700/80 px-1 pb-3 last:border-b-0">
            <header class="mb-2 flex items-center gap-2 text-xs">
              <strong class="text-zinc-200">${comment.author}</strong>
              <time class="text-zinc-500" datetime=${comment.createdAt}>${formatCommentTime(comment.createdAt)}</time>
              <button type="button" class="ml-auto inline-flex h-8 w-8 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-red-300 focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50"
                aria-label=${placement.deletingCommentId === comment.id ? `Deleting comment by ${comment.author}` : `Delete comment by ${comment.author}`}
                ?disabled=${placement.deletingCommentId !== null} @click=${() => void placement.deleteComment(comment.id)}
              >${placement.deletingCommentId === comment.id ? spinnerIcon("h-[18px] w-[18px] animate-spin") : trashIcon("h-[18px] w-[18px]")}</button>
            </header>
            <p class="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-100">${comment.body}</p>
          </article>`)}
        ${placement.composer ? html`
          <form class="rounded-md border border-zinc-700 bg-zinc-800/70 p-3 focus-within:border-sky-700" @submit=${this.save}>
            <label class="mb-2 block text-xs font-medium text-zinc-300" for=${`inline-comment-${placement.id}`}>${placement.comments.length ? "Add comment" : "Add a review comment"}</label>
            <textarea id=${`inline-comment-${placement.id}`}
              class="min-h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-950 p-2 text-base text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
              placeholder="Share feedback about this code…"
              .value=${placement.composer.body} ?disabled=${placement.composer.saving}
              aria-describedby=${placement.composer.error ? `inline-comment-error-${placement.id}` : nothing}
              @input=${this.updateDraft} @keydown=${this.handleComposerKeydown}></textarea>
            ${placement.composer.error ? html`<p id=${`inline-comment-error-${placement.id}`} class="mt-2 text-xs text-red-300" role="alert">${placement.composer.error}</p>` : nothing}
            <div class="mt-3 flex flex-wrap justify-end gap-2">
              <button type="button" class="min-h-11 rounded px-4 text-sm text-zinc-300 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400"
                aria-label="Cancel comment" ?disabled=${placement.composer.saving} @click=${this.cancel}>Cancel</button>
              <button type="submit" class="min-h-11 rounded bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                aria-label="Add review comment" ?disabled=${placement.composer.saving}
              >${placement.composer.saving ? "Adding…" : "Add comment"}</button>
            </div>
          </form>` : placement.comments.length ? html`
            <button type="button" class="mt-1 flex min-h-10 w-full items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/60 px-3 text-left text-sm text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-sky-400"
              @click=${placement.addComment}>${conversationIcon("h-4 w-4")}<span>Add comment</span></button>` : nothing}
      </section>`;
  }
}

function formatCommentTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function hasValue(value: unknown): value is { value: string } {
  return typeof value === "object" && value !== null && "value" in value && typeof value.value === "string";
}
declare global { interface HTMLElementTagNameMap { "review-comment-thread": ReviewCommentThread; } }
