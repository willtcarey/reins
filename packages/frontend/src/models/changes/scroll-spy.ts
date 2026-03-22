/**
 * ScrollSpy
 *
 * Tracks which observed element is topmost within a scroll container using
 * IntersectionObserver. Calls back with the `data-*` attribute value of the
 * topmost visible element whenever it changes.
 *
 * Usage:
 *   const spy = new ScrollSpy({
 *     containerSelector: "[data-diff-scroll]",
 *     itemSelector: "[data-file-path]",
 *     dataAttribute: "filePath",       // reads element.dataset.filePath
 *     onActiveChange: (id) => { ... },
 *   });
 *   spy.update(hostElement);  // call after each render
 *   spy.destroy();            // call on disconnect
 */

export interface ScrollSpyOptions {
  /** Selector for the scroll container within the host. */
  containerSelector: string;
  /** Selector for observed items within the container. */
  itemSelector: string;
  /** The `dataset` key to read from each observed element (camelCase). */
  dataAttribute: string;
  /** Called when the topmost visible item changes. */
  onActiveChange: (id: string) => void;
  /**
   * How much of the viewport counts as "top". Defaults to 25% (the item
   * is active when it enters the top quarter of the container).
   */
  topFraction?: number;
}

export class ScrollSpy {
  private observer: IntersectionObserver | null = null;
  private container: HTMLElement | null = null;
  private opts: ScrollSpyOptions;

  constructor(opts: ScrollSpyOptions) {
    this.opts = opts;
  }

  /**
   * Call after each render. Finds the scroll container within `host`,
   * creates the observer if the container changed, and observes any new items.
   */
  update(host: HTMLElement) {
    const container = host.querySelector<HTMLElement>(this.opts.containerSelector);
    if (!container) return;

    if (container !== this.container) {
      // Container changed — rebuild observer
      this.destroy();
      this.container = container;

      const bottomMargin = Math.round((this.opts.topFraction ?? 0.25) * 100);
      this.observer = new IntersectionObserver(
        (entries) => this.handleEntries(entries),
        {
          root: container,
          threshold: 0,
          rootMargin: `0px 0px -${100 - bottomMargin}% 0px`,
        }
      );
    }

    // Observe any new items (idempotent for already-observed elements)
    const items = container.querySelectorAll<HTMLElement>(this.opts.itemSelector);
    for (const item of items) {
      this.observer!.observe(item);
    }
  }

  /** Disconnect the observer and release references. */
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.container = null;
  }

  private handleEntries(entries: IntersectionObserverEntry[]) {
    let topmost: { id: string; top: number } | null = null;

    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      const id = el.dataset[this.opts.dataAttribute];
      if (!id) continue;
      const top = entry.boundingClientRect.top;
      if (!topmost || top < topmost.top) {
        topmost = { id, top };
      }
    }

    if (topmost) {
      this.opts.onActiveChange(topmost.id);
    }
  }
}
