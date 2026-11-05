/**
 * Springs a list's items from where they were to where a re-render put them (FLIP), with the shared `Spring`.
 * Items are the container's children with `data-reorder-key`. `capture()` before the DOM changes, `play()` after:
 * a moved item springs from its old offset, a new one springs in from a little below, faded. Reduced motion, or
 * no `requestAnimationFrame`, only moves them.
 */

import { Spring } from "../helpers/spring.js";

/** How far below its place a new item starts, in pixels; also the scale its fade runs over. */
const ENTER_OFFSET_PX = 12;

function reducedMotion(): boolean {
  return typeof window === "undefined"
    || typeof window.matchMedia !== "function"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function keyedItems(container: Element): Map<string, HTMLElement> {
  const items = new Map<string, HTMLElement>();
  for (const child of container.children) {
    const key = child.getAttribute("data-reorder-key");
    if (key !== null && child instanceof HTMLElement) items.set(key, child);
  }
  return items;
}

/**
 * How each item moves, by key, from the tops `capture` saw to the tops after the change: the offset to spring
 * from (moved by under a pixel: none), or `enter` for one that was not there.
 */
export function reorderMoves(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Map<string, number | "enter"> {
  const moves = new Map<string, number | "enter">();
  for (const [key, top] of after) {
    const was = before.get(key);
    if (was === undefined) moves.set(key, "enter");
    else if (Math.abs(was - top) >= 1) moves.set(key, was - top);
  }
  return moves;
}

function tops(items: ReadonlyMap<string, HTMLElement>): Map<string, number> {
  return new Map([...items].map(([key, item]) => [key, item.getBoundingClientRect().top]));
}

export class SpringReorder {
  private before: ReadonlyMap<string, number> = new Map();
  private captured = false;
  private springs = new Map<HTMLElement, Spring>();

  /** Records where each item is now, where it shows mid-spring included, and stops the springs. */
  capture(container: Element | null): void {
    this.captured = container !== null;
    this.before = container ? tops(keyedItems(container)) : new Map();
    this.stop();
  }

  /** Springs each item from where `capture` saw it. The first `play` after no capture, the first draw, only records. */
  play(container: Element | null): void {
    if (!container || !this.captured || reducedMotion()) return;
    const items = keyedItems(container);
    for (const [key, move] of reorderMoves(this.before, tops(items))) {
      const item = items.get(key);
      if (!item) continue;
      if (move === "enter") {
        this.spring(item, ENTER_OFFSET_PX, (value) => {
          item.style.transform = `translateY(${value}px)`;
          item.style.opacity = String(1 - value / ENTER_OFFSET_PX);
        });
      } else {
        this.spring(item, move, (value) => { item.style.transform = `translateY(${value}px)`; });
      }
    }
  }

  /** Stops every spring and leaves the items where they belong. */
  stop(): void {
    for (const [item, spring] of this.springs) {
      spring.cancel();
      item.style.removeProperty("transform");
      item.style.removeProperty("opacity");
    }
    this.springs.clear();
  }

  private spring(item: HTMLElement, from: number, apply: (value: number) => void): void {
    let settled = false;
    const spring = new Spring({
      value: from,
      target: 0,
      velocity: 0,
      onUpdate: (value) => apply(value),
      onSettle: () => {
        settled = true;
        this.springs.delete(item);
        item.style.removeProperty("transform");
        item.style.removeProperty("opacity");
      },
    });
    // Without animation frames the spring settles in its constructor.
    if (!settled) this.springs.set(item, spring);
  }
}
