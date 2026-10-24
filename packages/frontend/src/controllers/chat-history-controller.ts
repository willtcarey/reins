import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ScrollAnchorController } from "./scroll-anchor-controller.js";

interface HistoryContainer {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

type Options = {
  hasEarlierMessages(): boolean;
  loadPrevious(): Promise<boolean>;
  /** Keeps the reader's place while earlier messages are added above it. */
  anchor: Pick<ScrollAnchorController, "pin" | "restore">;
  touchDebounceMs?: number;
};

export class ChatHistoryController implements ReactiveController {
  loading = false;
  private armed = true;
  private touching = false;
  private timer?: ReturnType<typeof setTimeout>;
  private releaseAnchor?: () => void;
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
    this.releaseAnchor?.();
    this.releaseAnchor = undefined;
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
    if (!this.nearTop(container)) {
      if (!this.touching && !this.loading) this.armed = true;
      return;
    }
    if (!this.armed) return;
    if (!this.touching) {
      this.armed = false;
      void this.loadPrevious();
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.armed && !this.loading && this.nearTop(container)) {
        this.armed = false;
        void this.loadPrevious();
      }
    }, this.options.touchDebounceMs ?? 150);
  }

  async loadPrevious() {
    if (this.loading || !this.options.hasEarlierMessages()) return;
    this.armed = false;
    this.loading = true;
    this.releaseAnchor = this.options.anchor.pin();
    this.host.requestUpdate();

    const generation = this.generation;
    try {
      const loaded = await this.options.loadPrevious();
      if (generation !== this.generation) return;
      await this.host.updateComplete;
      // The new content's size is reported after this, when the pin is released: restore it now.
      // The pin covers a render that was laid out before the load resolved.
      if (generation === this.generation && loaded) this.options.anchor.restore();
    } finally {
      if (generation === this.generation) {
        this.releaseAnchor?.();
        this.releaseAnchor = undefined;
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  private nearTop(container: HistoryContainer) {
    const fromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return fromBottom >= 50 && container.scrollTop <= Math.max(80, container.clientHeight);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
