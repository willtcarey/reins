/**
 * Tests for diff-hunk gap expansion controls.
 */
import { describe, expect, test } from "bun:test";
import { DiffHunk } from "../../../components/changes/diff-hunk.js";
import type { DiffFile, DiffHunk as DiffHunkType, DiffLine } from "../../../models/changes/types.js";
import { collectTemplateValues, templateToString } from "../../helpers/lit-template.js";

function line(type: DiffLine["type"], text: string, oldLine?: number, newLine?: number): DiffLine {
  return { type, text, oldLine, newLine };
}

function hunk(start: number, end: number): DiffHunkType {
  const lines: DiffLine[] = [];
  for (let lineNo = start; lineNo <= end; lineNo++) {
    lines.push(line("context", `line${lineNo}`, lineNo, lineNo));
  }
  return { header: `@@ -${start},${end - start + 1} +${start},${end - start + 1} @@`, lines };
}

function file(hunks: DiffHunkType[]): DiffFile {
  return { path: "src/foo.ts", additions: 0, removals: 0, hunks };
}

function component(diffFile: DiffFile, hunkIndex: number): DiffHunk {
  const el = new DiffHunk();
  el.file = diffFile;
  el.hunkIndex = hunkIndex;
  el.gutterCh = 3;
  return el;
}

describe("DiffHunk gap expansion controls", () => {
  test("large inter-hunk gaps expose separate controls from both sides", () => {
    const diffFile = file([
      hunk(5, 10),
      hunk(40, 45),
    ]);

    const preceding = component(diffFile, 0);
    const following = component(diffFile, 1);
    const events: Array<{ event: string; hunkIndex: number }> = [];
    preceding.addEventListener("expand-down", (event) => {
      if (event instanceof CustomEvent) {
        events.push({ event: "expand-down", hunkIndex: event.detail.hunkIndex });
      }
    });
    following.addEventListener("expand-up", (event) => {
      if (event instanceof CustomEvent) {
        events.push({ event: "expand-up", hunkIndex: event.detail.hunkIndex });
      }
    });

    const trailer = preceding.renderTrailer();
    const separator = following.renderSeparator();

    expect(templateToString(trailer)).toContain("Show 15 of 29 hidden lines below");
    expect(templateToString(separator)).toContain("Show 15 of 29 hidden lines above");

    const trailerHandlers = collectTemplateValues(trailer).filter((value): value is () => void => typeof value === "function");
    const separatorHandlers = collectTemplateValues(separator).filter((value): value is () => void => typeof value === "function");
    expect(trailerHandlers).toHaveLength(1);
    expect(separatorHandlers).toHaveLength(1);

    trailerHandlers[0]();
    separatorHandlers[0]();

    expect(events).toEqual([
      { event: "expand-down", hunkIndex: 0 },
      { event: "expand-up", hunkIndex: 1 },
    ]);
  });

  test("small inter-hunk gap control expands upward from the following hunk", () => {
    const diffFile = file([
      hunk(5, 10),
      hunk(13, 18),
    ]);
    const following = component(diffFile, 1);
    const events: Array<{ event: string; hunkIndex: number }> = [];
    following.addEventListener("expand-up", (event) => {
      if (event instanceof CustomEvent) {
        events.push({ event: "expand-up", hunkIndex: event.detail.hunkIndex });
      }
    });
    following.addEventListener("expand-down", (event) => {
      if (event instanceof CustomEvent) {
        events.push({ event: "expand-down", hunkIndex: event.detail.hunkIndex });
      }
    });

    const separator = following.renderSeparator();
    const separatorText = templateToString(separator);
    expect(separatorText).toContain("↕");
    expect(separatorText).toContain("Expand 2 hidden lines");

    const handlers = collectTemplateValues(separator).filter((value): value is () => void => typeof value === "function");
    expect(handlers).toHaveLength(1);

    handlers[0]();

    expect(events).toEqual([{ event: "expand-up", hunkIndex: 1 }]);
  });
});
