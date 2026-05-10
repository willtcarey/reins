/**
 * ScrollToController
 *
 * Keeps a host element's target child item visible without forcing a scroll on
 * every render. If the target item is outside the scroll viewport, it scrolls
 * that item into the requested position; if the item is already visible, it
 * leaves the user's scroll position alone.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

export interface ScrollToElement {
  id: string;
  getAttribute(name: string): string | null;
  closest(selector: string): ScrollToContainer | null;
  getBoundingClientRect(): Pick<DOMRect, "top" | "bottom">;
  scrollIntoView(options?: boolean | ScrollIntoViewOptions): void;
}

export interface ScrollToContainer {
  getBoundingClientRect(): Pick<DOMRect, "top" | "bottom">;
}

export interface ScrollToHost extends ReactiveControllerHost {
  querySelectorAll(selectors: string): Iterable<ScrollToElement>;
}

export interface ScrollToControllerOptions {
  /** Return the id of the target item, or null/undefined when none is active. */
  getTargetId(): string | null | undefined;

  /** Selector for candidate target elements within the host. */
  targetSelector: string;

  /** Return an item's id. Defaults to the element's id attribute. */
  getItemId?: (element: ScrollToElement) => string | undefined;

  /** Optional selector for the scroll viewport that contains each item. */
  scrollContainerSelector?: string;

  /** Where to place the item when scrolling is needed. Defaults to center. */
  block?: ScrollLogicalPosition;

  /** Optional scroll behavior. Defaults to the browser's instant behavior. */
  behavior?: ScrollBehavior;
}

export class ScrollToController implements ReactiveController {
  private _host: ScrollToHost;
  private _options: ScrollToControllerOptions;
  private _lastScrolledId: string | null = null;
  private _scrollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    host: ScrollToHost,
    options: ScrollToControllerOptions,
  ) {
    this._host = host;
    this._options = options;
    host.addController(this);
  }

  hostUpdated() {
    this.scheduleScroll();
  }

  hostDisconnected() {
    this.clearScrollTimer();
  }

  /** Clear cached state so the current target item may be scrolled again. */
  reset() {
    this._lastScrolledId = null;
    this.clearScrollTimer();
  }

  /** Schedule scrolling after child custom elements have had a chance to render. */
  scheduleScroll() {
    const targetId = this._options.getTargetId();
    if (!targetId) {
      this._lastScrolledId = null;
      return;
    }
    if (targetId === this._lastScrolledId) return;

    this.clearScrollTimer();
    this._scrollTimer = setTimeout(() => {
      this._scrollTimer = null;
      this.scrollTargetIntoView();
    }, 0);
  }

  /** Scroll the target item if needed. Returns true once the item is found. */
  scrollTargetIntoView() {
    const targetId = this._options.getTargetId();
    if (!targetId || targetId === this._lastScrolledId) return false;

    const targetItem = this.findTargetItem(targetId);
    if (!targetItem) return false;

    if (!this.isFullyVisible(targetItem)) {
      const scrollOptions: ScrollIntoViewOptions = {
        block: this._options.block ?? "center",
      };
      if (this._options.behavior) {
        scrollOptions.behavior = this._options.behavior;
      }
      targetItem.scrollIntoView(scrollOptions);
    }

    this._lastScrolledId = targetId;
    return true;
  }

  private findTargetItem(targetId: string) {
    const itemId = this._options.getItemId ?? ((item) => item.id);
    const items = Array.from(this._host.querySelectorAll(this._options.targetSelector));
    return items.find((item) => itemId(item) === targetId) ?? null;
  }

  private isFullyVisible(item: ScrollToElement) {
    const container = this._options.scrollContainerSelector
      ? item.closest(this._options.scrollContainerSelector)
      : null;
    const itemRect = item.getBoundingClientRect();
    const viewportRect = container?.getBoundingClientRect();
    const top = viewportRect?.top ?? 0;
    const bottom = viewportRect?.bottom
      ?? (typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight);

    return itemRect.top >= top && itemRect.bottom <= bottom;
  }

  private clearScrollTimer() {
    if (!this._scrollTimer) return;
    clearTimeout(this._scrollTimer);
    this._scrollTimer = null;
  }
}
