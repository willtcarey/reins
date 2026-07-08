import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { Spring } from "../../models/spring.js";
import { SwipePagerSwipe, type SwipePagerSwipeState } from "../../models/swipe-pager-swipe.js";

export interface SwipePagerPageChangeDetail {
  page: number;
}

@customElement("swipe-pager")
export class SwipePager extends LitElement {
  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.page = this.clampPage(this.initialPage);
    this.addEventListener("touchmove", this.handleTouchMoveCapture, {
      capture: true,
      passive: false,
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("touchmove", this.handleTouchMoveCapture, { capture: true });
    this.swipe?.dispose();
    this.swipe = null;
    this.cancelSpringAnimation();
  }

  @property({ type: Number }) initialPage = 0;
  @property({ type: Number }) page = 0;
  @property({ type: Number }) pageCount = 0;
  @property({ attribute: false }) pages: unknown[] = [];
  @property({ type: String }) shellClass = "h-full min-h-0 min-w-0 overflow-hidden swipe-pager-shell";
  @property({ type: String }) stripClass = "swipe-pager-strip flex h-full min-h-0";
  @property({ type: String }) pageClass = "h-full min-h-0 shrink-0 overflow-hidden";

  @query("[data-swipe-pager-shell]") private shell?: HTMLElement;

  @state() private translateX: number | null = null;
  @state() private dragging = false;
  @state() private settling = false;
  private pendingPage: number | null = null;
  private pageSpring: Spring | null = null;
  private swipe: SwipePagerSwipe | null = null;

  public goToPage(page: number) {
    this.setPage(page);
  }

  public resetToPage(page: number) {
    this.swipe?.dispose();
    this.swipe = null;
    this.cancelSpringAnimation();
    this.page = this.clampPage(page);
    this.translateX = null;
    this.pendingPage = null;
    this.dragging = false;
  }

  private get effectivePageCount() {
    return Math.max(1, Math.floor(this.pageCount || this.pages.length || 1));
  }

  private clampPage(page: number) {
    const lastPage = Math.max(0, Math.floor(this.effectivePageCount) - 1);
    return Math.min(Math.max(Math.round(page), 0), lastPage);
  }

  private getViewportWidth() {
    const shellWidth = this.shell?.clientWidth ?? 0;
    if (shellWidth > 0) return shellWidth;
    if (typeof window === "undefined") return 1;
    return Math.max(1, window.innerWidth);
  }

  private pageTranslateX(page: number) {
    return -this.clampPage(page) * this.getViewportWidth();
  }

  private dispatchPageChange() {
    this.dispatchEvent(new CustomEvent<SwipePagerPageChangeDetail>("page-change", {
      detail: { page: this.page },
      bubbles: true,
      composed: true,
    }));
  }

  private commitPage(page: number) {
    const nextPage = this.clampPage(page);
    const changed = nextPage !== this.page;
    this.page = nextPage;
    if (changed) this.dispatchPageChange();
  }

  private cancelSpringAnimation() {
    this.pageSpring?.cancel();
    this.pageSpring = null;
    this.settling = false;
  }

  private setPage(page: number) {
    const targetPage = this.clampPage(page);
    const startX = this.translateX ?? this.pageTranslateX(this.page);
    const targetX = this.pageTranslateX(targetPage);

    this.swipe?.dispose();
    this.swipe = null;
    this.dragging = false;

    if (targetPage === this.page && this.pendingPage === null && Math.abs(startX - targetX) <= 0.5) {
      this.cancelSpringAnimation();
      this.translateX = null;
      return;
    }

    this.startSpringAnimation(targetPage, startX, 0);
  }

  private finishSpringAnimation() {
    const targetPage = this.pendingPage;
    this.pageSpring = null;
    if (targetPage !== null) this.commitPage(targetPage);
    this.pendingPage = null;
    this.translateX = null;
    this.settling = false;
  }

  private startSpringAnimation(
    targetPage: number,
    startX: number,
    velocityX: number,
  ) {
    this.cancelSpringAnimation();
    this.pendingPage = this.clampPage(targetPage);
    this.settling = true;
    this.pageSpring = new Spring({
      value: startX,
      target: this.pageTranslateX(this.pendingPage),
      velocity: velocityX,
      onUpdate: (value) => { this.translateX = value; },
      onSettle: () => this.finishSpringAnimation(),
    });
  }

  private handleSwipeStateChange(swipeState: SwipePagerSwipeState) {
    this.translateX = swipeState.translateX;
    this.dragging = swipeState.dragging;
    this.settling = swipeState.settling;
  }

  private handleSwipeDone(swipe: SwipePagerSwipe) {
    if (this.swipe !== swipe) return;

    this.swipe = null;
  }

  private handlePointerDown(e: PointerEvent) {
    const swipe = SwipePagerSwipe.start({
      event: e,
      page: this.page,
      pageCount: this.effectivePageCount,
      getViewportWidth: () => this.getViewportWidth(),
      onStateChange: (swipeState) => this.handleSwipeStateChange(swipeState),
      onCommitPage: (page) => this.commitPage(page),
      onDone: (completedSwipe) => this.handleSwipeDone(completedSwipe),
    });
    if (!swipe) return;

    this.swipe?.dispose();
    this.cancelSpringAnimation();
    this.swipe = swipe;
  }

  private handlePointerMove(e: PointerEvent) {
    this.swipe?.move(e);
  }

  private handlePointerEnd(e: PointerEvent) {
    this.swipe?.end(e);
  }

  private handlePointerCancel(e: PointerEvent) {
    this.swipe?.cancel(e);
  }

  private handleTouchMoveCapture(e: TouchEvent) {
    this.swipe?.touchMoveCapture(e);
  }

  private handleClickCapture(e: Event) {
    this.swipe?.clickCapture(e);
  }

  override render() {
    const pageCount = this.effectivePageCount;
    const translateX = this.translateX ?? this.pageTranslateX(this.page);
    const style = `width: ${pageCount * 100}%; transform: translate3d(${translateX}px, 0, 0);`;
    const pageStyle = `width: ${100 / pageCount}%;`;

    return html`
      <div
        class=${this.shellClass}
        data-swipe-pager-shell
        @click=${{ handleEvent: (e: Event) => this.handleClickCapture(e), capture: true }}
        @pointerdown=${this.handlePointerDown}
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerEnd}
        @pointercancel=${this.handlePointerCancel}
      >
        <div
          class=${this.stripClass}
          data-dragging=${this.dragging || this.settling ? "true" : "false"}
          style=${style}
        >
          ${this.pages.map((page) => html`
            <section class=${this.pageClass} style=${pageStyle}>${page}</section>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "swipe-pager": SwipePager;
  }
}
