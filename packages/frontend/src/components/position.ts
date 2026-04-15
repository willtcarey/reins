/**
 * Shared fixed-positioning utility.
 *
 * Computes `{ top, left }` for a floating element anchored to a trigger,
 * with automatic edge-flipping and viewport clamping. Used by nav-icon
 * tooltips and popover-menu panels.
 *
 * Placement follows the `side-alignment` convention:
 *   side  = which edge of the anchor the floating element appears on
 *   align = how the floating element aligns along the cross axis
 *
 * Examples: "bottom-end" = below the anchor, right-aligned
 *           "right"      = right of the anchor, vertically centered
 */

type Side = "top" | "bottom" | "left" | "right";
type Alignment = "start" | "center" | "end";
export type Placement = `${Side}-${Alignment}` | Side;

export interface PositionOptions {
  /** Bounding rect of the trigger element. */
  anchor: DOMRect;
  /** Measured width of the floating element (use offsetWidth). */
  width: number;
  /** Measured height of the floating element (use offsetHeight). */
  height: number;
  /** Preferred placement relative to the anchor. */
  placement: Placement;
  /** Gap between anchor edge and floating element (default 4). */
  gap?: number;
  /** Minimum distance from viewport edge (default 4). */
  viewportPad?: number;
}

/**
 * Compute top/left for a fixed-positioned floating element.
 *
 * 1. Places the element on the preferred side.
 * 2. Flips to the opposite side if it would overflow.
 * 3. Clamps to the viewport on both axes.
 */

const placementMap: Record<Placement, { side: Side; align: Alignment }> = {
  "top":          { side: "top",    align: "center" },
  "top-start":    { side: "top",    align: "start" },
  "top-center":   { side: "top",    align: "center" },
  "top-end":      { side: "top",    align: "end" },
  "bottom":       { side: "bottom", align: "center" },
  "bottom-start": { side: "bottom", align: "start" },
  "bottom-center":{ side: "bottom", align: "center" },
  "bottom-end":   { side: "bottom", align: "end" },
  "left":         { side: "left",   align: "center" },
  "left-start":   { side: "left",   align: "start" },
  "left-center":  { side: "left",   align: "center" },
  "left-end":     { side: "left",   align: "end" },
  "right":        { side: "right",  align: "center" },
  "right-start":  { side: "right",  align: "start" },
  "right-center": { side: "right",  align: "center" },
  "right-end":    { side: "right",  align: "end" },
};

function parsePlacement(p: Placement): { side: Side; align: Alignment } {
  return placementMap[p];
}

export function computePosition(opts: PositionOptions): { top: number; left: number } {
  const { anchor, width, height, placement, gap = 4, viewportPad = 4 } = opts;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const { side, align } = parsePlacement(placement);

  let top: number;
  let left: number;

  if (side === "bottom" || side === "top") {
    // Primary axis: vertical.
    if (side === "bottom") {
      top = anchor.bottom + gap;
      if (top + height > vh - viewportPad) top = anchor.top - gap - height;
    } else {
      top = anchor.top - gap - height;
      if (top < viewportPad) top = anchor.bottom + gap;
    }

    // Cross axis: horizontal alignment.
    if (align === "start") left = anchor.left;
    else if (align === "end") left = anchor.right - width;
    else left = anchor.left + anchor.width / 2 - width / 2;
  } else {
    // Primary axis: horizontal.
    if (side === "right") {
      left = anchor.right + gap;
      if (left + width > vw - viewportPad) left = anchor.left - gap - width;
    } else {
      left = anchor.left - gap - width;
      if (left < viewportPad) left = anchor.right + gap;
    }

    // Cross axis: vertical alignment.
    if (align === "start") top = anchor.top;
    else if (align === "end") top = anchor.bottom - height;
    else top = anchor.top + anchor.height / 2 - height / 2;
  }

  // Clamp to viewport.
  left = Math.max(viewportPad, Math.min(left, vw - width - viewportPad));
  top = Math.max(viewportPad, Math.min(top, vh - height - viewportPad));

  return { top, left };
}
