import { Spring } from "./spring.js";

type SwipeGestureAxis = "pending" | "horizontal" | "vertical";

const MIN_SWIPE_DISTANCE = 12;
const HORIZONTAL_DOMINANCE = 1.25;
const SWIPE_SURFACE_SELECTOR = "[data-swipe-surface]";

const SWIPE_ALWAYS_IGNORE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

const SWIPE_CONDITIONAL_IGNORE_SELECTOR = [
  "button",
  "a",
  "summary",
  "label",
  "[role='button']",
  "[role='link']",
].join(",");

export interface SwipeState {
  translateX: number | null;
  dragging: boolean;
  settling: boolean;
}

export interface SwipeTarget {
  translateX: number;
  onSettle?: () => void;
}

export interface SwipeRelease {
  dx: number;
  velocityX: number;
}

export interface SwipeStartOptions {
  event: PointerEvent;
  getDragTranslateX: (dx: number) => number;
  getReleaseTarget: (release: SwipeRelease) => SwipeTarget;
  getCancelTarget: () => SwipeTarget;
  onStateChange: (state: SwipeState) => void;
  onDone: (swipe: Swipe) => void;
}

interface SwipePointerState {
  pointerId: number;
  startX: number;
  startY: number;
  startPath: readonly EventTarget[];
  lastX: number;
  lastTime: number;
  axis: SwipeGestureAxis;
}

function classifySwipeGesture(
  dx: number,
  dy: number,
): SwipeGestureAxis {
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

function shouldIgnoreSwipeDrag(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;

  if (target.closest(SWIPE_ALWAYS_IGNORE_SELECTOR) !== null) return true;

  const interactive = target.closest(SWIPE_CONDITIONAL_IGNORE_SELECTOR) !== null;
  if (!interactive) return false;

  return target.closest(SWIPE_SURFACE_SELECTOR) === null;
}

function shouldLetHorizontalScrollHandleSwipeDrag(
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
export class Swipe {
  private pointer: SwipePointerState;
  private translateX: number | null = null;
  private dragging = false;
  private settling = false;
  private pendingTarget: SwipeTarget | null = null;
  private spring: Spring | null = null;
  private suppressNextClick = false;
  private clickSuppressionPending = false;
  private terminal = false;
  private disposed = false;
  private doneNotified = false;

  private constructor(private readonly options: SwipeStartOptions, startPath: readonly EventTarget[]) {
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

  static start(options: SwipeStartOptions): Swipe | null {
    const event = options.event;
    if (!event.isPrimary || shouldIgnoreSwipeDrag(event.target)) return null;

    const startPath: EventTarget[] = [];
    if (typeof event.composedPath === "function") {
      for (const target of event.composedPath()) {
        if (target) startPath.push(target);
      }
    }
    if (startPath.length === 0 && event.target) startPath.push(event.target);

    return new Swipe(options, startPath);
  }

  move(event: PointerEvent) {
    if (this.disposed || event.pointerId !== this.pointer.pointerId) return;

    const dx = event.clientX - this.pointer.startX;
    const dy = event.clientY - this.pointer.startY;

    if (this.pointer.axis === "pending") {
      this.pointer.axis = classifySwipeGesture(dx, dy);
      if (this.pointer.axis === "vertical") {
        this.complete();
        return;
      }
      if (this.pointer.axis === "horizontal") {
        if (shouldLetHorizontalScrollHandleSwipeDrag(this.pointer.startPath, dx)) {
          this.complete();
          return;
        }

        this.dragging = true;
        this.setPointerCapture(event);
      }
    }

    if (this.pointer.axis !== "horizontal") return;

    event.preventDefault();
    this.translateX = this.options.getDragTranslateX(dx);
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
    this.startSpringAnimation(
      this.options.getReleaseTarget({ dx, velocityX }),
      this.translateX ?? this.options.getDragTranslateX(dx),
      velocityX,
    );
  }

  cancel(event: PointerEvent) {
    if (this.disposed || event.pointerId !== this.pointer.pointerId) return;

    // Browsers commonly cancel pending pointers once they claim a vertical
    // scroll. Nothing has been rendered yet, so springing from that pointer's
    // horizontal offset would create a page movement out of a non-swipe.
    if (this.pointer.axis !== "horizontal") {
      this.complete();
      return;
    }

    this.startSpringAnimation(
      this.options.getCancelTarget(),
      this.translateX ?? this.options.getDragTranslateX(event.clientX - this.pointer.startX),
      0,
    );
  }

  touchMoveCapture(event: { preventDefault(): void }): boolean {
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

  private startSpringAnimation(target: SwipeTarget, startX: number, velocityX: number) {
    this.cancelSpringAnimation();
    this.pendingTarget = target;
    this.dragging = false;
    this.settling = true;
    this.spring = new Spring({
      value: startX,
      target: target.translateX,
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

    const target = this.pendingTarget;
    this.spring = null;
    target?.onSettle?.();
    this.pendingTarget = null;
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
