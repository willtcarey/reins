import { beforeEach, describe, expect, test } from "bun:test";

// computePosition reads window.innerWidth / innerHeight, so provide a
// minimal window object when running outside a browser (bun test).
const VW = 1024;
const VH = 768;

const _win: Record<string, unknown> = {};
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: _win, configurable: true });
}

import { computePosition, type Placement, type PositionOptions } from "../../components/position.js";

type Side = "top" | "bottom" | "left" | "right";

// --- helpers ----------------------------------------------------------------

/** Build a DOMRect-like object from x, y, width, height. */
function rect(x: number, y: number, w: number, h: number): DOMRect {
  const r: DOMRect = { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() {} } satisfies DOMRect;
  return r;
}

/** Shorthand: compute with sensible defaults for the floating element. */
function compute(
  placement: Placement,
  anchor: DOMRect,
  floatW = 80,
  floatH = 60,
  extra: Partial<Pick<PositionOptions, "gap" | "viewportPad">> = {},
) {
  return computePosition({ anchor, width: floatW, height: floatH, placement, ...extra });
}

// --- setup ------------------------------------------------------------------

beforeEach(() => {
  _win.innerWidth = VW;
  _win.innerHeight = VH;
});

// A centered anchor far from any edge — no flipping or clamping expected.
const center = rect(400, 300, 50, 30);

// --- basic placement on all four sides --------------------------------------

describe("basic placement", () => {
  test("bottom: positions below the anchor", () => {
    const { top, left } = compute("bottom", center);
    expect(top).toBe(center.bottom + 4);
    expect(left).toBe(center.left + center.width / 2 - 80 / 2);
  });

  test("top: positions above the anchor", () => {
    const { top, left } = compute("top", center);
    expect(top).toBe(center.top - 4 - 60);
    expect(left).toBe(center.left + center.width / 2 - 80 / 2);
  });

  test("right: positions to the right of the anchor", () => {
    const { top, left } = compute("right", center);
    expect(left).toBe(center.right + 4);
    expect(top).toBe(center.top + center.height / 2 - 60 / 2);
  });

  test("left: positions to the left of the anchor", () => {
    const { top, left } = compute("left", center);
    expect(left).toBe(center.left - 4 - 80);
    expect(top).toBe(center.top + center.height / 2 - 60 / 2);
  });
});

// --- alignments (tested on "bottom" side) -----------------------------------

describe("alignment on bottom side", () => {
  test("bottom-start: left-aligns with anchor left", () => {
    const { left } = compute("bottom-start", center);
    expect(left).toBe(center.left);
  });

  test("bottom-center: centers on the anchor", () => {
    const { left } = compute("bottom-center", center);
    expect(left).toBe(center.left + center.width / 2 - 80 / 2);
  });

  test("bottom-end: right-aligns with anchor right", () => {
    const { left } = compute("bottom-end", center);
    expect(left).toBe(center.right - 80);
  });

  test("all three share the same top value", () => {
    const topStart = compute("bottom-start", center).top;
    const topCenter = compute("bottom-center", center).top;
    const topEnd = compute("bottom-end", center).top;
    expect(topStart).toBe(topCenter);
    expect(topCenter).toBe(topEnd);
    expect(topStart).toBe(center.bottom + 4);
  });
});

// --- alignments on horizontal side ------------------------------------------

describe("alignment on right side", () => {
  test("right-start: top-aligns with anchor top", () => {
    const { top } = compute("right-start", center);
    expect(top).toBe(center.top);
  });

  test("right-center: vertically centers on the anchor", () => {
    const { top } = compute("right-center", center);
    expect(top).toBe(center.top + center.height / 2 - 60 / 2);
  });

  test("right-end: bottom-aligns with anchor bottom", () => {
    const { top } = compute("right-end", center);
    expect(top).toBe(center.bottom - 60);
  });
});

// --- shorthand placements default to center alignment -----------------------

describe("shorthand placements default to center", () => {
  const sides: Side[] = ["top", "bottom", "left", "right"];

  for (const s of sides) {
    test(`"${s}" matches "${s}-center"`, () => {
      const short = compute(s, center);
      const explicit = compute(`${s}-center`, center);
      expect(short).toEqual(explicit);
    });
  }
});

// --- edge flipping ----------------------------------------------------------

describe("edge-flipping", () => {
  test("bottom flips to top when anchor is near the bottom edge", () => {
    const lowAnchor = rect(400, 720, 50, 30);
    const { top } = compute("bottom", lowAnchor, 80, 60);
    // Would have been 750 + 4 = 754, 754 + 60 = 814 > 764 → flips
    expect(top).toBe(lowAnchor.top - 4 - 60);
  });

  test("top flips to bottom when anchor is near the top edge", () => {
    const highAnchor = rect(400, 10, 50, 30);
    const { top } = compute("top", highAnchor, 80, 60);
    // Would have been 10 - 4 - 60 = -54 < 4 → flips
    expect(top).toBe(highAnchor.bottom + 4);
  });

  test("right flips to left when anchor is near the right edge", () => {
    const rightAnchor = rect(970, 300, 20, 30);
    const { left } = compute("right", rightAnchor, 80, 60);
    // Would have been 990 + 4 = 994, 994 + 80 = 1074 > 1020 → flips
    expect(left).toBe(rightAnchor.left - 4 - 80);
  });

  test("left flips to right when anchor is near the left edge", () => {
    const leftAnchor = rect(10, 300, 50, 30);
    const { left } = compute("left", leftAnchor, 80, 60);
    // Would have been 10 - 4 - 80 = -74 < 4 → flips
    expect(left).toBe(leftAnchor.right + 4);
  });
});

// --- viewport clamping ------------------------------------------------------

describe("viewport clamping", () => {
  test("clamps left when cross-axis alignment pushes past the left edge", () => {
    // bottom-end with anchor near left edge — anchor.right - width goes negative
    const leftAnchor = rect(10, 300, 20, 30);
    const { left } = compute("bottom-end", leftAnchor, 80, 60);
    // anchor.right - width = 30 - 80 = -50 → clamped to viewportPad (4)
    expect(left).toBe(4);
  });

  test("clamps right when cross-axis alignment pushes past the right edge", () => {
    // bottom-start with anchor near right edge
    const rightAnchor = rect(980, 300, 30, 30);
    const { left } = compute("bottom-start", rightAnchor, 80, 60);
    // anchor.left = 980, 980 + 80 = 1060 > 1020 → clamped to 1024 - 80 - 4 = 940
    expect(left).toBe(VW - 80 - 4);
  });

  test("clamps top when cross-axis alignment pushes past the top edge", () => {
    // right-end with anchor near top — anchor.bottom - height goes negative
    const topAnchor = rect(400, 10, 50, 20);
    const { top } = compute("right-end", topAnchor, 80, 60);
    // anchor.bottom - height = 30 - 60 = -30 → clamped to 4
    expect(top).toBe(4);
  });

  test("clamps bottom when cross-axis alignment pushes past the bottom edge", () => {
    // right-start with anchor near bottom
    const bottomAnchor = rect(400, 740, 50, 20);
    const { top } = compute("right-start", bottomAnchor, 80, 60);
    // anchor.top = 740, 740 + 60 = 800 > 764 → clamped to 768 - 60 - 4 = 704
    expect(top).toBe(VH - 60 - 4);
  });

  test("clamps both axes simultaneously", () => {
    // Anchor in bottom-right corner, bottom-start placement
    const cornerAnchor = rect(990, 740, 20, 20);
    const { top, left } = compute("bottom-start", cornerAnchor, 80, 60);
    // left: anchor.left = 990, 990 + 80 > 1020 → clamped to 940
    expect(left).toBe(VW - 80 - 4);
    // top: after flip (760 + 4 + 60 > 764) → top = 740 - 4 - 60 = 676, but still clamped check
    expect(top).toBeLessThanOrEqual(VH - 60 - 4);
    expect(top).toBeGreaterThanOrEqual(4);
  });
});

// --- custom gap and viewportPad values --------------------------------------

describe("custom gap", () => {
  test("gap increases distance from anchor", () => {
    const { top } = compute("bottom", center, 80, 60, { gap: 12 });
    expect(top).toBe(center.bottom + 12);
  });

  test("gap=0 places element flush against anchor", () => {
    const { top } = compute("bottom", center, 80, 60, { gap: 0 });
    expect(top).toBe(center.bottom);
  });

  test("custom gap applies to horizontal side too", () => {
    const { left } = compute("right", center, 80, 60, { gap: 20 });
    expect(left).toBe(center.right + 20);
  });
});

describe("custom viewportPad", () => {
  test("larger viewportPad tightens the clamping boundary", () => {
    const rightAnchor = rect(980, 300, 30, 30);
    const { left } = compute("bottom-start", rightAnchor, 80, 60, { viewportPad: 20 });
    // Clamped to VW - width - viewportPad = 1024 - 80 - 20 = 924
    expect(left).toBe(VW - 80 - 20);
  });

  test("viewportPad=0 allows positioning at the viewport edge", () => {
    const rightAnchor = rect(980, 300, 30, 30);
    const { left } = compute("bottom-start", rightAnchor, 80, 60, { viewportPad: 0 });
    // Clamped to VW - width - 0 = 1024 - 80 = 944
    expect(left).toBe(VW - 80);
  });

  test("larger viewportPad triggers flip sooner", () => {
    // With small pad, bottom placement fits. With large pad, it flips to top.
    const midAnchor = rect(400, 660, 50, 30);
    const noFlip = compute("bottom", midAnchor, 80, 60, { viewportPad: 4 });
    const flips = compute("bottom", midAnchor, 80, 60, { viewportPad: 50 });
    // No flip: 690 + 4 = 694, 694 + 60 = 754 < 764 → no flip, top = 694
    expect(noFlip.top).toBe(midAnchor.bottom + 4);
    // Flips: 694 + 60 = 754 > 718 → flip, top = 660 - 4 - 60 = 596
    expect(flips.top).toBe(midAnchor.top - 4 - 60);
  });
});
