import { Spring } from "./spring.js";

type SwipePagerGestureAxis = "pending" | "horizontal" | "vertical";

const MIN_SWIPE_DISTANCE = 12;
const HORIZONTAL_DOMINANCE = 1.25;
const SETTLE_DISTANCE_RATIO = 0.35;
const SETTLE_INERTIA_MS = 180;
const EDGE_RESISTANCE = 0.4;

const SWIPE_PAGER_SURFACE_SELECTOR = "[data-swipe-pager-surface]";

const SWIPE_PAGER_ALWAYS_IGNORE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

const SWIPE_PAGER_CONDITIONAL_IGNORE_SELECTOR = [
  "button",
  "a",
  "summary",
  "label",
  "[role='button']",
  "[role='link']",
].join(",");

export interface SwipePagerSwipeState {
  translateX: number | null;
  dragging: boolean;
  settling: boolean;
}

export interface SwipePagerSwipeStartOptions {
  event: PointerEvent;
  page: number;
  pageCount: number;
  getViewportWidth: () => number;
  onStateChange: (state: SwipePagerSwipeState) => void;
  onCommitPage: (page: number) => void;
  onDone: (swipe: SwipePagerSwipe) => void;
}

interface SwipePagerSwipePointerState {
  pointerId: number;
  startX: number;
  startY: number;
  startPath: readonly EventTarget[];
  lastX: number;
  lastTime: number;
  axis: SwipePagerGestureAxis;
}

function classifySwipePagerGesture(
  dx: number,
  dy: number,
): SwipePagerGestureAxis {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (absX < MIN_SWIPE_DISTANCE && absY < MIN_SWIPE_DISTANCE) {
    return "pending";
  }

  if (absX >= MIN_SWIPE_DISTANCE && absX > absY * HORIZONTAL_DOMINANCE) {
    return "horizontal";
  }

  return "vertical";
}

function clampPage(page: number, pageCount: number): number {
  const lastPage = Math.max(0, Math.floor(pageCount) - 1);
  return Math.min(Math.max(Math.round(page), 0), lastPage);
}

function swipePagerDragOffset(
  currentPage: number,
  dx: number,
  pageCount: number,
): number {
  const clampedPage = clampPage(currentPage, pageCount);
  const lastPage = clampPage(Number.POSITIVE_INFINITY, pageCount);
  if ((clampedPage === 0 && dx > 0) || (clampedPage === lastPage && dx < 0)) {
    return dx * EDGE_RESISTANCE;
  }

  return dx;
}

function settleSwipePagerPage(
  currentPage: number,
  dx: number,
  velocityX: number,
  viewportWidth: number,
  pageCount: number,
): number {
  const width = Math.max(1, viewportWidth);
  const clampedPage = clampPage(currentPage, pageCount);
  const projectedDx = dx + velocityX * SETTLE_INERTIA_MS;

  if (Math.abs(projectedDx) < width * SETTLE_DISTANCE_RATIO) return clampedPage;

  if (projectedDx < 0) return clampPage(clampedPage + 1, pageCount);
  if (projectedDx > 0) return clampPage(clampedPage - 1, pageCount);

  return clampedPage;
}

function shouldIgnoreSwipePagerDrag(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;

  if (target.closest(SWIPE_PAGER_ALWAYS_IGNORE_SELECTOR) !== null) return true;

  const interactive = target.closest(SWIPE_PAGER_CONDITIONAL_IGNORE_SELECTOR) !== null;
  if (!interactive) return false;

  return target.closest(SWIPE_PAGER_SURFACE_SELECTOR) === null;
}

function shouldLetHorizontalScrollHandleSwipePagerDrag(
  targetOrPath: EventTarget | readonly EventTarget[] | null,
  dx: number,
): boolean {
  if (dx === 0 || typeof HTMLElement === "undefined") return false;

  const targets = Array.isArray(targetOrPath)
    ? targetOrPath
    : targetOrPath == null ? [] : [targetOrPath];
  const inspected = new Set<HTMLElement>();

  for (const target of targets) {
    if (!(target instanceof HTMLElement)) continue;
    for (let element: HTMLElement | null = target; element; element = element.parentElement) {
      if (inspected.has(element)) continue;
      inspected.add(element);
      if (!canElementScrollHorizontally(element)) continue;

      return true;
    }
  }

  return false;
}

function canElementScrollHorizontally(element: HTMLElement): boolean {
  if (element.scrollWidth <= element.clientWidth + 1) return false;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return true;

  const overflowX = window.getComputedStyle(element).overflowX;
  return overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay";
}

/**
 * Owns one pointer-driven swipe interaction from pointerdown through the release
 * spring. The hosting component only delegates DOM events and renders emitted
 * state; all per-swipe mutable state stays scoped to this instance.
 */
export class SwipePagerSwipe {
  private pointer: SwipePagerSwipePointerState;
  private translateX: number | null = null;
  private dragging = false;
  private settling = false;
  private dragOffset = 0;
  private pendingPage: number | null = null;
  private spring: Spring | null = null;
  private suppressNextClick = false;
  private clickSuppressionPending = false;
  private terminal = false;
  private disposed = false;
  private doneNotified = false;

  private constructor(private readonly options: SwipePagerSwipeStartOptions, startPath: readonly EventTarget[]) {
    const event = options.event;
    this.pointer = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPath,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      axis: "pending",
    };
  }

  static start(options: SwipePagerSwipeStartOptions): SwipePagerSwipe | null {
    const event = options.event;
    if (!event.isPrimary || shouldIgnoreSwipePagerDrag(event.target)) return null;

    const startPath: EventTarget[] = [];
    if (typeof event.composedPath === "function") {
      for (const target of event.composedPath()) {
        if (target) startPath.push(target);
      }
    }
    if (startPath.length === 0 && event.target) startPath.push(event.target);

    return new SwipePagerSwipe(options, startPath);
  }

  move(event: PointerEvent) {
    if (this.disposed || event.pointerId !== this.pointer.pointerId) return;

    const dx = event.clientX - this.pointer.startX;
    const dy = event.clientY - this.pointer.startY;

    if (this.pointer.axis === "pending") {
      this.pointer.axis = classifySwipePagerGesture(dx, dy);
      if (this.pointer.axis === "vertical") {
        this.complete();
        return;
      }
      if (this.pointer.axis === "horizontal") {
        if (shouldLetHorizontalScrollHandleSwipePagerDrag(this.pointer.startPath, dx)) {
          this.complete();
          return;
        }

        this.dragging = true;
        this.setPointerCapture(event);
      }
    }

    if (this.pointer.axis !== "horizontal") return;

    event.preventDefault();
    this.dragOffset = swipePagerDragOffset(this.options.page, dx, this.options.pageCount);
    this.translateX = this.pageTranslateX(this.options.page) + this.dragOffset;
    this.pointer.lastX = event.clientX;
    this.pointer.lastTime = event.timeStamp;
    this.emitState();
  }

  end(event: PointerEvent) {
    if (this.disposed || event.pointerId !== this.pointer.pointerId) return;

    const dx = event.clientX - this.pointer.startX;
    const elapsed = Math.max(1, event.timeStamp - this.pointer.lastTime);
    const velocityX = (event.clientX - this.pointer.lastX) / elapsed;

    if (this.pointer.axis !== "horizontal") {
      this.complete();
      return;
    }

    this.startClickSuppression();
    const targetPage = settleSwipePagerPage(
      this.options.page,
      dx,
      velocityX,
      this.options.getViewportWidth(),
      this.options.pageCount,
    );
    this.startSpringAnimation(
      targetPage,
      this.pageTranslateX(this.options.page) + this.dragOffset,
      velocityX,
    );
  }

  cancel(event: PointerEvent) {
    if (this.disposed || event.pointerId !== this.pointer.pointerId) return;

    this.startSpringAnimation(
      this.options.page,
      this.pageTranslateX(this.options.page) + this.dragOffset,
      0,
    );
  }

  touchMoveCapture(event: TouchEvent): boolean {
    if (this.disposed || this.pointer.axis !== "horizontal") return false;

    event.preventDefault();
    return true;
  }

  clickCapture(event: Event): boolean {
    if (this.disposed || !this.suppressNextClick) return false;

    this.suppressNextClick = false;
    this.clickSuppressionPending = false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.completeIfReady();
    return true;
  }

  dispose() {
    this.disposed = true;
    this.cancelSpringAnimation();
    this.suppressNextClick = false;
    this.clickSuppressionPending = false;
  }

  private setPointerCapture(event: PointerEvent) {
    if (typeof HTMLElement === "undefined" || !(event.currentTarget instanceof HTMLElement)) return;
    if (typeof event.currentTarget.setPointerCapture !== "function") return;

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  private pageTranslateX(page: number) {
    return -clampPage(page, this.options.pageCount) * this.options.getViewportWidth();
  }

  private emitState() {
    this.options.onStateChange({
      translateX: this.translateX,
      dragging: this.dragging,
      settling: this.settling,
    });
  }

  private startClickSuppression() {
    this.suppressNextClick = true;
    this.clickSuppressionPending = true;
    const setTimeoutFn = typeof window !== "undefined" ? window.setTimeout : globalThis.setTimeout;
    setTimeoutFn(() => {
      this.suppressNextClick = false;
      this.clickSuppressionPending = false;
      this.completeIfReady();
    }, 0);
  }

  private startSpringAnimation(targetPage: number, startX: number, velocityX: number) {
    this.cancelSpringAnimation();
    this.pendingPage = clampPage(targetPage, this.options.pageCount);
    this.dragging = false;
    this.settling = true;
    this.spring = new Spring({
      value: startX,
      target: this.pageTranslateX(this.pendingPage),
      velocity: velocityX,
      onUpdate: (value) => {
        this.translateX = value;
        this.emitState();
      },
      onSettle: () => this.finishSpringAnimation(),
    });
  }

  private finishSpringAnimation() {
    if (this.disposed) return;

    const targetPage = this.pendingPage;
    this.spring = null;
    if (targetPage !== null) this.options.onCommitPage(targetPage);
    this.pendingPage = null;
    this.translateX = null;
    this.dragging = false;
    this.settling = false;
    this.emitState();
    this.complete();
  }

  private cancelSpringAnimation() {
    this.spring?.cancel();
    this.spring = null;
    this.settling = false;
  }

  private complete() {
    this.terminal = true;
    this.dragging = false;
    this.completeIfReady();
  }

  private completeIfReady() {
    if (this.disposed || this.doneNotified || !this.terminal || this.clickSuppressionPending) return;

    this.doneNotified = true;
    this.disposed = true;
    this.options.onDone(this);
  }
}
