import { describe, expect, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { ReviewCommentThread } from "../../../components/changes/review-comment-thread.js";
import { ReviewFileDiff } from "../../../components/changes/review-file-diff.js";
import { SpringCollapseDirective } from "../../../directives/spring-collapse.js";
import { FileDiffContextState } from "../../../models/changes/file-diff-context-state.js";
import { parseFileChanges } from "../../../models/changes/file-changes.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
  templateToString,
} from "../../helpers/lit-template.js";

interface DirectiveResult {
  _$litDirective$: typeof SpringCollapseDirective;
  values: Parameters<SpringCollapseDirective["render"]>;
}

function testRect(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function noAnchor(): number | null { return null; }

function renderOutput(item: ReviewFileDiff): string {
  const template = item.render();
  const collapse = collectTemplateValues(template).find((value): value is DirectiveResult => (
    typeof value === "object"
      && value !== null
      && "_$litDirective$" in value
      && value._$litDirective$ === SpringCollapseDirective
  ));
  if (!collapse) return templateToString(template);

  const childPart: PartInfo = { type: PartType.CHILD };
  const directive = new SpringCollapseDirective(childPart);
  return templateToString(template) + templateToString(directive.render(...collapse.values));
}

const PATCH = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new
`;

const EXPANDABLE_PATCH = PATCH.replace("@@ -1 +1 @@", "@@ -33 +33 @@");
const BINARY_PATCH = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/image.png differ
`;

describe("ReviewFileDiff", () => {
  test("presents a binary change without an empty diff body", () => {
    const fileChange = parseFileChanges(BINARY_PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    item.change = fileChange;

    const output = renderOutput(item);

    expect(output).toContain("image.png");
    expect(output).toContain("Binary file added — no textual diff is available.");
    expect(output).toContain("<diff-download-file-button");
    expect(output).not.toContain("data-pierre-file-diff");
  });

  test("presents an oversized file as a measured limit notice", () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    item.change = { ...fileChange, additions: 10_000 };
    item.getBoundingClientRect = () => testRect(122);
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    const measurements: unknown[] = [];
    item.onHeightChange = (_change, update) => measurements.push(update);

    const output = renderOutput(item);
    item.updated();

    expect(output).toContain("src/example.ts");
    expect(output).toContain("Diff not rendered");
    expect(output).toContain("10,001 changed lines exceeds the 10,000-line limit");
    expect(output).toContain("background-color:var(--reins-diff-background)");
    expect(output).toContain("<diff-view-file-button");
    expect(measurements).toEqual([{ kind: "measurement", height: 122 }]);
    expect(output).not.toContain("<diffs-container");
  });

  test("measures its host after the current Pierre render completes", () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    const container = new ReviewFileDiff();
    item.change = fileChange;
    item.reservedHeight = 240;
    item.getBoundingClientRect = () => testRect(137);
    item.querySelector = () => { throw new Error("ReviewFileDiff must not inspect rendered DOM"); };
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    const renderer: object = Reflect.get(item, "_diff");
    item.render();
    const requested = Reflect.get(renderer, "requested");
    Reflect.set(renderer, "containerValue", container);
    Reflect.set(renderer, "completed", requested);
    const measurements: unknown[] = [];
    item.onHeightChange = (_change, update) => measurements.push(update);

    item.updated();

    expect(measurements).toEqual([{ kind: "measurement", height: 137 }]);
    expect(renderOutput(item)).not.toContain("min-height:240px");
  });

  test("remeasures the same height after the comment layout revision changes", () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    const container = new ReviewFileDiff();
    item.change = fileChange;
    item.inlineReview = { placements: [], selection: null, error: null, threadCount: 0, layoutRevision: 0,
      select: () => {}, openComposer: () => {}, reportError: () => {} };
    item.getBoundingClientRect = () => testRect(137);
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    const renderer: object = Reflect.get(item, "_diff");
    item.render();
    const requested = Reflect.get(renderer, "requested");
    Reflect.set(renderer, "containerValue", container);
    Reflect.set(renderer, "completed", requested);
    const measurements: unknown[] = [];
    item.onHeightChange = (_change, update) => measurements.push(update);

    item.updated();
    const previous = item.inlineReview;
    item.inlineReview = { placements: [{ id: "draft", range: { side: "new", startLine: 1, endLine: 1 }, comments: [], deletingCommentId: null, deleteComment: async () => {}, addComment: () => {}, composer: {
      body: "", error: null, saving: false, input: () => {}, save: async () => {}, cancel: () => {},
    } }], selection: { side: "new", startLine: 1, endLine: 1 }, error: null, threadCount: 0, layoutRevision: 1,
      select: () => {}, openComposer: () => {}, reportError: () => {} };
    item.willUpdate(new Map([["inlineReview", previous]]));
    item.updated();

    expect(measurements).toEqual([
      { kind: "measurement", height: 137 },
      { kind: "measurement", height: 137 },
    ]);
  });

  test("preserves scroll from the active comment element when its layout changes", () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    const thread = new ReviewCommentThread();
    const placement = { id: "draft", range: { side: "new" as const, startLine: 1, endLine: 1 }, comments: [], deletingCommentId: null, deleteComment: async () => {}, addComment: () => {}, composer: {
      body: "", error: null, saving: false, input: () => {}, save: async () => {}, cancel: () => {},
    } };
    thread.placement = placement;
    thread.getBoundingClientRect = () => ({ ...testRect(100), top: 42 });
    item.change = fileChange;
    Object.defineProperty(item, "querySelectorAll", { value: () => [thread] });
    let resolveAnchor: () => number | null = noAnchor;
    item.onCommentLayoutChange = (_change, resolve) => { resolveAnchor = resolve; };
    const previous = { placements: [], selection: null, error: null, threadCount: 0, layoutRevision: 0,
      select: () => {}, openComposer: () => {}, reportError: () => {} };
    item.inlineReview = { ...previous, placements: [placement], layoutRevision: 1 };

    item.willUpdate(new Map([["inlineReview", previous]]));

    expect(resolveAnchor()).toBe(42);
  });

  test("does not emit for stale completion after Lit removes the current structure", () => {
    const parsed = parseFileChanges(PATCH, "project-7-v1");
    const fileChange = parsed.changes[0]!;
    const item = new ReviewFileDiff();
    item.change = fileChange;
    item.reservedHeight = 240;
    item.getBoundingClientRect = () => testRect(137);
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    const renderer: object = Reflect.get(item, "_diff");
    item.render();
    Reflect.set(renderer, "completed", Reflect.get(renderer, "requested"));

    const measurements: unknown[] = [];
    item.onHeightChange = (_change, update) => measurements.push(update);
    item.updated();

    expect(item.diffRendered).toBe(false);
    expect(measurements).toEqual([]);
    expect(renderOutput(item)).toContain("min-height:240px");
  });

  test("renders an accessible collapse control and hides only the diff body when collapsed", () => {
    const parsed = parseFileChanges(PATCH, "project-7-v1");
    const fileChange = parsed.changes[0]!;
    const item = new ReviewFileDiff();
    item.change = fileChange;
    item.collapsed = true;
    const toggledIds: string[] = [];
    item.onToggleCollapse = (id) => toggledIds.push(id);

    const rendered = item.render();
    const output = renderOutput(item);
    collectTemplateEventListeners(rendered, "click")[0]?.call(item, new Event("click"));

    expect(output).toContain(`<button`);
    expect(output).toContain(`aria-label=Expand src/example.ts`);
    expect(output).toContain(`aria-expanded=false`);
    expect(output).toContain("src/example.ts");
    expect(output).not.toContain("data-pierre-file-diff");
    expect(toggledIds).toEqual([fileChange.id]);
  });

  test("shows the inline comment count with a comment icon in the file header", async () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    item.change = fileChange;
    item.inlineReview = {
      placements: [
        { id: "old", range: { side: "old", startLine: 1, endLine: 1 }, comments: [{ id: "1", author: "You", body: "old note", createdAt: "2026-09-08T14:30:00.000Z" }], deletingCommentId: null, deleteComment: async () => {}, addComment: () => {}, composer: null },
        { id: "new", range: { side: "new", startLine: 1, endLine: 1 }, comments: [{ id: "2", author: "You", body: "new note", createdAt: "2026-09-08T14:31:00.000Z" }], deletingCommentId: null, deleteComment: async () => {}, addComment: () => {}, composer: {
          body: "", error: null, saving: false, input: () => {}, save: async () => {}, cancel: () => {},
        } },
      ],
      selection: { side: "new", startLine: 1, endLine: 1 }, error: null, threadCount: 2, layoutRevision: 3,
      select: () => {}, openComposer: () => {}, reportError: () => {},
    };

    const output = renderOutput(item);

    expect(output).toContain("aria-label=2 inline comments");
    expect(output).toContain(">2</span>");
    expect(output).not.toContain("2 comments");
    expect(output).not.toContain("draft");
  });

  test("keeps comment creation on selected diff lines instead of offering manual range entry", () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    item.change = fileChange;

    const output = renderOutput(item);

    expect(output).not.toContain("Add inline comment");
    expect(output).not.toContain('role="dialog"');
    expect(output).not.toContain("Start line");
  });

  test("does not request complete content merely by rendering an expandable file", () => {
    const fileChange = parseFileChanges(EXPANDABLE_PATCH, "project-7-v1").changes[0]!;
    const item = new ReviewFileDiff();
    const contextState = new FileDiffContextState({ projectId: 7, mode: "branch" });
    item.change = fileChange;
    item.contextState = contextState;

    item.render();

    expect(contextState.forChange(fileChange).outcome).toBe("idle");
  });

  test("updates when its persistent context state changes", async () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const state = new FileDiffContextState(
      { projectId: 7, mode: "branch" },
      async () => { throw new Error("offline"); },
    );
    const item = new ReviewFileDiff();
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    item.change = fileChange;
    item.contextState = state;
    let updates = 0;
    item.requestUpdate = () => { updates += 1; };

    await expect(state.loadFiles(fileChange)).rejects.toBeDefined();

    expect(updates).toBe(2);
  });

  test("leaves expansion controls to Pierre and reports acquisition failure without replacing the diff", async () => {
    const fileChange = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const state = new FileDiffContextState(
      { projectId: 7, mode: "branch" },
      async () => { throw new Error("offline"); },
    );
    await expect(state.loadFiles(fileChange)).rejects.toBeDefined();
    const item = new ReviewFileDiff();
    item.change = fileChange;
    item.contextState = state;

    const output = renderOutput(item);

    expect(output).toContain("<div data-pierre-file-diff");
    expect(output).toContain("Unable to load complete file context.");
  });

  test("exposes accessible status labels for each changed-file status", () => {
    const parsed = parseFileChanges(PATCH, "project-7-v1");
    const item = new ReviewFileDiff();
    const fileChange = parsed.changes[0]!;

    for (const [status, label] of [
      ["change", "Modified file"],
      ["new", "Added file"],
      ["deleted", "Deleted file"],
      ["rename-pure", "Renamed file"],
      ["rename-changed", "Renamed file"],
    ] as const) {
      item.change = { ...fileChange, status };
      expect(templateToString(item.render())).toContain(`aria-label="${label}"`);
    }
  });
});
