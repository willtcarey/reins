import type { ReactiveController, ReactiveControllerHost } from "lit";
import { Swipe, type SwipeRelease, type SwipeState, type SwipeTarget } from "../models/swipe.js";

const SETTLE_DISTANCE_RATIO = 0.35;
const SETTLE_INERTIA_MS = 180;
const EDGE_RESISTANCE = 0.4;

export interface PageSwipeControllerOptions {
  pageCount: number | (() => number);
  getPage: () => number;
  commitPage: (page: number) => void;
  isEnabled: () => boolean;
}

type EventHost = ReactiveControllerHost & EventTarget;

/**
 * Lit controller for pointer-driven horizontal page swipes.
 *
 * The host owns the rendered page layout and page semantics; this controller
 * owns DOM event plumbing, one active Swipe instance, and transient render state.
 */
export class PageSwipeController implements ReactiveController {
  translateX: number | null = null;
  dragging = false;
  settling = false;

  readonly clickCaptureHandler = {
    handleEvent: (event: Event) => this.handleClickCapture(event),
    capture: true,
  };

  private swipe: Swipe | null = null;
  private lastPage: number;
  private swipeViewportWidth = 1;
  private touchMoveListener: EventListener = (event) => this.handleTouchMoveCapture(event);

  constructor(
    private readonly host: EventHost,
    private readonly options: PageSwipeControllerOptions,
  ) {
    this.lastPage = options.getPage();
    host.addController(this);
  }

  hostConnected() {
    this.host.addEventListener("touchmove", this.touchMoveListener, {
      capture: true,
      passive: false,
    });
  }

  hostDisconnected() {
    this.host.removeEventListener("touchmove", this.touchMoveListener, { capture: true });
    this.disposeSwipe();
  }

  syncPage() {
    const page = this.options.getPage();
    if (page === this.lastPage) return;

    this.lastPage = page;
    // External page changes supersede any in-flight gesture; otherwise a stale
    // release/spring can commit its old target after programmatic navigation.
    this.disposeSwipe();
    this.resetState();
  }

  handlePointerDown = (event: PointerEvent) => {
    if (!this.options.isEnabled()) return;

    this.syncPage();
    this.swipeViewportWidth = this.viewportWidthForEvent(event);
    const startPage = this.clampPage(this.options.getPage());
    const swipe = Swipe.start({
      event,
      getDragTranslateX: (dx) => this.pageTranslateX(startPage) + this.dragOffset(startPage, dx),
      getReleaseTarget: (release) => this.releaseTarget(startPage, release),
      getCancelTarget: () => ({ translateX: this.pageTranslateX(startPage) }),
      onStateChange: (state) => this.handleSwipeStateChange(state),
      onDone: (completedSwipe) => this.handleSwipeDone(completedSwipe),
    });
    if (!swipe) return;

    this.disposeSwipe();
    this.swipe = swipe;
  };

  handlePointerMove = (event: PointerEvent) => {
    this.swipe?.move(event);
  };

  handlePointerEnd = (event: PointerEvent) => {
    this.swipe?.end(event);
  };

  handlePointerCancel = (event: PointerEvent) => {
    this.swipe?.cancel(event);
  };

  handleTouchMoveCapture = (event: Event) => {
    this.swipe?.touchMoveCapture(event);
  };

  handleClickCapture(event: Event) {
    this.swipe?.clickCapture(event);
  }

  private clampPage(page: number): number {
    const lastPage = Math.max(0, Math.floor(this.pageCount()) - 1);
    return Math.min(Math.max(Math.round(page), 0), lastPage);
  }

  private pageTranslateX(page: number): number {
    return -this.clampPage(page) * this.swipeViewportWidth;
  }

  private dragOffset(currentPage: number, dx: number): number {
    const clampedPage = this.clampPage(currentPage);
    const lastPage = this.clampPage(Number.POSITIVE_INFINITY);
    if ((clampedPage === 0 && dx > 0) || (clampedPage === lastPage && dx < 0)) {
      return dx * EDGE_RESISTANCE;
    }

    return dx;
  }

  private settlePage(currentPage: number, release: SwipeRelease): number {
    const width = this.swipeViewportWidth;
    const clampedPage = this.clampPage(currentPage);
    const projectedDx = release.dx + release.velocityX * SETTLE_INERTIA_MS;

    if (Math.abs(projectedDx) < width * SETTLE_DISTANCE_RATIO) return clampedPage;

    if (projectedDx < 0) return this.clampPage(clampedPage + 1);
    if (projectedDx > 0) return this.clampPage(clampedPage - 1);

    return clampedPage;
  }

  private releaseTarget(startPage: number, release: SwipeRelease): SwipeTarget {
    const targetPage = this.settlePage(startPage, release);
    return {
      translateX: this.pageTranslateX(targetPage),
      onSettle: () => {
        this.lastPage = targetPage;
        this.options.commitPage(targetPage);
      },
    };
  }

  private pageCount(): number {
    return typeof this.options.pageCount === "function"
      ? this.options.pageCount()
      : this.options.pageCount;
  }

  private viewportWidthForEvent(event: PointerEvent): number {
    if (typeof HTMLElement !== "undefined"
      && event.currentTarget instanceof HTMLElement
      && event.currentTarget.clientWidth > 0
    ) {
      return event.currentTarget.clientWidth;
    }

    if (typeof window !== "undefined" && window.innerWidth > 0) {
      return window.innerWidth;
    }

    return 1;
  }

  private handleSwipeStateChange(state: SwipeState) {
    this.translateX = state.translateX;
    this.dragging = state.dragging;
    this.settling = state.settling;
    this.host.requestUpdate();
  }

  private handleSwipeDone(swipe: Swipe) {
    if (this.swipe !== swipe) return;

    this.swipe = null;
  }

  private disposeSwipe() {
    this.swipe?.dispose();
    this.swipe = null;
  }

  private resetState() {
    this.translateX = null;
    this.dragging = false;
    this.settling = false;
  }
}
