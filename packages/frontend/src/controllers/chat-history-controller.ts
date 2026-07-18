import type { ReactiveController, ReactiveControllerHost } from "lit";

type Snapshot = [key: string, bottomOffset: number, scrollTop: number];

interface HistoryAnchor {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Pick<DOMRect, "bottom">;
}

interface HistoryContainer {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
  getBoundingClientRect(): Pick<DOMRect, "top" | "bottom">;
  querySelectorAll(selectors: string): ArrayLike<HistoryAnchor>;
}

type Options = {
  hasEarlierMessages(): boolean;
  loadPrevious(): Promise<boolean>;
  touchDebounceMs?: number;
};

export class ChatHistoryController implements ReactiveController {
  loading = false;
  private armed = true;
  private touching = false;
  private timer?: ReturnType<typeof setTimeout>;
  private loadingScrollTop?: number;
  private generation = 0;

  constructor(
    private host: ReactiveControllerHost,
    private options: Options,
  ) {
    host.addController(this);
  }

  hostDisconnected() { this.reset(); }
  reset() {
    this.generation++;
    this.clearTimer();
    this.armed = true;
    this.touching = false;
    this.loadingScrollTop = undefined;
    if (this.loading) {
      this.loading = false;
      this.host.requestUpdate();
    }
  }

  handleTouchStart() {
    this.touching = this.armed = true;
    this.clearTimer();
  }

  handleScroll(container: HistoryContainer) {
    if (this.loading) this.loadingScrollTop = container.scrollTop;
    if (!this.nearTop(container)) {
      if (!this.touching && !this.loading) this.armed = true;
      return;
    }
    if (!this.armed) return;
    if (!this.touching) {
      this.armed = false;
      void this.loadPrevious(container);
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.armed && !this.loading && this.nearTop(container)) {
        this.armed = false;
        void this.loadPrevious(container);
      }
    }, this.options.touchDebounceMs ?? 150);
  }

  async loadPrevious(container: HistoryContainer) {
    if (this.loading || !this.options.hasEarlierMessages()) return;
    this.armed = false;
    this.loading = true;
    this.loadingScrollTop = container.scrollTop;
    this.host.requestUpdate();

    const generation = this.generation;
    const snapshot = this.snapshot(container);
    const { scrollHeight, scrollTop } = container;
    try {
      const loaded = await this.options.loadPrevious();
      if (generation !== this.generation) return;
      await this.host.updateComplete;
      if (generation !== this.generation || !loaded) return;
      if (!snapshot || !this.restore(container, snapshot)) {
        container.scrollTop = scrollTop + container.scrollHeight - scrollHeight;
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.loadingScrollTop = undefined;
        this.host.requestUpdate();
      }
    }
  }

  private nearTop(container: HistoryContainer) {
    const fromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return fromBottom >= 50 && container.scrollTop <= Math.max(80, container.clientHeight);
  }

  private snapshot(container: HistoryContainer): Snapshot | undefined {
    const viewport = container.getBoundingClientRect();
    const anchor = Array.from(container.querySelectorAll("[data-conversation-key]"))
      .find((item) => item.getBoundingClientRect().bottom >= viewport.top);
    const key = anchor?.getAttribute("data-conversation-key");
    return anchor && key
      ? [key, viewport.bottom - anchor.getBoundingClientRect().bottom, container.scrollTop]
      : undefined;
  }

  private restore(container: HistoryContainer, [key, oldOffset, oldTop]: Snapshot) {
    const anchor = Array.from(container.querySelectorAll("[data-conversation-key]"))
      .find((item) => item.getAttribute("data-conversation-key") === key);
    if (!anchor) return false;
    const newOffset = container.getBoundingClientRect().bottom - anchor.getBoundingClientRect().bottom;
    container.scrollTop += oldOffset + (this.loadingScrollTop ?? oldTop) - oldTop - newOffset;
    return true;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
