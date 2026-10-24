import type { ReactiveController, ReactiveControllerHost } from "lit";

interface AnchorBox {
  readonly isConnected: boolean;
  readonly children: ArrayLike<AnchorBox>;
  getBoundingClientRect(): Pick<DOMRect, "top" | "bottom" | "width" | "height">;
}

interface AnchorContainer extends AnchorBox {
  scrollTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** `offset` is the bottom edge's distance below the element's `side`. */
interface Anchor {
  element: AnchorBox;
  side: "top" | "bottom";
  offset: number;
  width: number;
  height: number;
}

type Options = {
  container(): AnchorContainer | null;
  /** While true, a resize moves nothing (another animation owns the scroll position). */
  locked?(): boolean;
};

/**
 * Keeps what is read at the bottom edge of a scroll container in place when the container is
 * resized, which reflows its content under the same scrollTop. At the end, the last element keeps
 * its bottom at the edge, so the container stays at its end.
 *
 * The anchor is the deepest element at the edge: one crossing it keeps its top, one wholly above it
 * (the edge in a gap, or past the end) its bottom. A resize can only be measured after it, so the
 * anchor is taken beforehand: when observing starts, on each scroll (`save`), and whenever the
 * content alone changes size (a render, an expanded block), which would otherwise leave an old
 * anchor to jump back to. Taking it there, after layout, never forces one.
 *
 * Content added above the reader (earlier history) changes only the content's size, so it moves the
 * text unless the anchor is pinned for it (`pin`), which restores the anchor after every change.
 */
export class ScrollAnchorController implements ReactiveController {
  private anchor: Anchor | null = null;
  private observer: { observe(target: object): void; disconnect(): void } | null = null;
  private observed: AnchorContainer | null = null;
  private pins = 0;

  constructor(host: ReactiveControllerHost, private options: Options) {
    host.addController(this);
  }

  hostConnected() { this.observe(); }
  hostUpdated() { this.observe(); }
  hostDisconnected() {
    this.observer?.disconnect();
    this.observed = null;
  }

  save() {
    const container = this.shown();
    if (container) this.anchor = anchorAt(container);
  }

  /** Puts the anchor back where it was saved. */
  restore() {
    const container = this.shown();
    const anchor = this.anchor;
    if (!container || !anchor?.element.isConnected || this.options.locked?.()) return;
    container.scrollTop += anchor.offset - edgeOffset(container, anchor.element, anchor.side);
  }

  /** Until released, every change of size puts the anchor back, not only the container's. */
  pin(): () => void {
    this.pins++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pins--;
    };
  }

  private observe() {
    if (typeof ResizeObserver === "undefined") return;
    const container = this.options.container();
    if (container === this.observed) return;
    this.observer ??= new ResizeObserver(() => this.resized());
    this.observer.disconnect();
    this.observed = container;
    this.anchor = null;
    if (!container) return;
    // The container's children hold the content, so they change size when it reflows or grows.
    this.observer.observe(container);
    for (const child of Array.from(container.children)) this.observer.observe(child);
  }

  private resized() {
    const container = this.shown();
    if (!container) return;
    const anchor = this.anchor;
    if (anchor && (this.pins > 0 || anchor.width !== container.clientWidth || anchor.height !== container.clientHeight)) this.restore();
    this.save();
  }

  /** Hidden, the container has no layout: its anchor is kept for when it is shown again. */
  private shown(): AnchorContainer | null {
    const container = this.observed;
    return container && container.clientWidth && container.clientHeight ? container : null;
  }
}

function edgeOffset(container: AnchorContainer, element: AnchorBox, side: "top" | "bottom") {
  return container.getBoundingClientRect().bottom - element.getBoundingClientRect()[side];
}

function anchorAt(container: AnchorContainer): Anchor | null {
  const edge = container.getBoundingClientRect().bottom;
  const size = { width: container.clientWidth, height: container.clientHeight };
  let found: Anchor | null = null;
  let parent: AnchorBox = container;
  for (;;) {
    const child = lastStartingAbove(parent, edge);
    if (!child) return found;
    const box = child.getBoundingClientRect();
    if (box.bottom <= edge) return { element: child, side: "bottom", offset: edge - box.bottom, ...size };
    found = { element: child, side: "top", offset: edge - box.top, ...size };
    parent = child;
  }
}

/** Children are in reading order, and a reader is mostly near the end: search from there. */
function lastStartingAbove(parent: AnchorBox, edge: number): AnchorBox | null {
  for (let index = parent.children.length - 1; index >= 0; index--) {
    const child = parent.children[index]!;
    const box = child.getBoundingClientRect();
    // An element that is not shown has no box.
    if (box.width === 0 && box.height === 0) continue;
    if (box.top < edge) return child;
  }
  return null;
}
