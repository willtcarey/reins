import {
  FileDiff,
  type DiffLineAnnotation,
  type ExpansionDirections,
  type FileDiffMetadata,
  type FileDiffOptions,
  type HunkExpansionRegion,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import { PierreRenderer } from "../../controllers/pierre-renderer.js";
import type {
  ReviewComments,
  ReviewLineSelection,
} from "../../models/changes/review-comments.js";
import { getPierreWorkerPool, PIERRE_SHIKI_THEME } from "../../models/changes/pierre-worker-pool.js";
import { ReviewCommentThread } from "./review-comment-thread.js";

type PierreCommentPlacementMetadata = string;

const REINS_DIFF_OPTIONS: FileDiffOptions<PierreCommentPlacementMetadata> = {
  theme: PIERRE_SHIKI_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  hunkSeparators: "line-info",
  expansionLineCount: 15,
  disableFileHeader: true,
  enableLineSelection: true,
  controlledSelection: true,
  enableGutterUtility: true,
};

export interface ReviewFileExpansionInteraction {
  readonly hunkIndex: number;
  readonly direction: ExpansionDirections;
  readonly lineCount?: number;
  readonly anchorTop: number;
  readonly anchorLineNumber: number | null;
  readonly anchorLineTop?: number | null;
}

export interface ReviewFileDiffTarget {
  readonly fileDiff: FileDiffMetadata;
  readonly nativeExpandedHunks: ReadonlyMap<number, HunkExpansionRegion>;
  readonly initialExpansion: ReviewFileExpansionInteraction | null;
  readonly comments?: ReviewComments | null;
  readonly fileId?: string;
}

/**
 * The only state adapter around FileDiff expansion. Pierre remains responsible
 * for changing, clamping, and joining expanded hunk regions.
 */
export class PierreReviewFileDiff extends FileDiff<PierreCommentPlacementMetadata> {
  private interactionCleanup: (() => void) | null = null;

  setInteractionCleanup(cleanup: () => void): void {
    this.interactionCleanup = cleanup;
  }

  override cleanUp(recycle = false): void {
    this.interactionCleanup?.();
    this.interactionCleanup = null;
    super.cleanUp(recycle);
  }

  restoreNativeExpansion(regions: ReadonlyMap<number, HunkExpansionRegion>): void {
    for (const [hunkIndex, region] of regions) {
      if (region.fromStart > 0) this.expandHunk(hunkIndex, "up", region.fromStart);
      if (region.fromEnd > 0) this.expandHunk(hunkIndex, "down", region.fromEnd);
    }
  }

  nativeExpansionState(): ReadonlyMap<number, HunkExpansionRegion> {
    return this.hunksRenderer.getExpandedHunksMap();
  }
}

export class ReviewFileDiffRenderer extends PierreRenderer<ReviewFileDiffTarget, PierreReviewFileDiff> {
  private target: ReviewFileDiffTarget | null = null;

  override bind(target: ReviewFileDiffTarget) {
    this.target = target;
    return super.bind(target);
  }

  refreshInlineComments(): void {
    const target = this.target;
    const renderer = this.instance;
    if (!target || !renderer) return;
    renderer.setLineAnnotations(commentAnnotations(target));
    renderer.setSelectedLines(commentSelection(target), { notify: false });
    renderer.rerender();
  }

  refreshInlineSelection(): void {
    const target = this.target;
    const renderer = this.instance;
    if (!target || !renderer) return;
    renderer.setSelectedLines(commentSelection(target), { notify: false });
  }
}

export function createReviewFileDiffRenderer(
  host: ReactiveControllerHost,
  onRendered?: () => void,
  onAcquire?: (interaction: ReviewFileExpansionInteraction) => void,
  onNativeInteraction?: (
    interaction: ReviewFileExpansionInteraction,
    mutate: () => void,
    resolveAnchor: () => number | null,
  ) => void,
  onNativeState?: (regions: ReadonlyMap<number, HunkExpansionRegion>) => void,
  workerManager?: ReturnType<typeof getPierreWorkerPool> | null,
) {
  return new ReviewFileDiffRenderer(host, {
    create: (target, rendered) => {
      let listeningRoot: ShadowRoot | null = null;
      let renderer: PierreReviewFileDiff;
      const handleInteraction = (event: Event) => {
        const interaction = expansionInteraction(event);
        if (!interaction) return;
        // Own activation before Pierre's bubbling InteractionManager. Partial
        // arrays must never reach expandHunk, and complete activation needs the
        // same first-hunk direction for pointer and keyboard input.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (target.fileDiff.isPartial) {
          onAcquire?.(interaction);
          return;
        }

        const mutate = () => renderer.expandHunk(
          interaction.hunkIndex,
          interaction.direction,
          interaction.lineCount,
        );
        if (onNativeInteraction) {
          onNativeInteraction(interaction, mutate, () => expansionAnchorTop(listeningRoot, interaction));
        } else {
          mutate();
        }
      };
      const handleClick = (event: Event) => handleInteraction(event);
      const handleKeydown = (event: Event) => {
        if (!("key" in event) || (event.key !== "Enter" && event.key !== " ")) return;
        handleInteraction(event);
      };
      renderer = new PierreReviewFileDiff({
        ...REINS_DIFF_OPTIONS,
        onLineSelected: (range) => {
          if (!target.comments || !target.fileId) return;
          target.comments.dispatch({
            type: "select",
            fileId: target.fileId,
            selection: range ? reviewSelection(range) : null,
          });
        },
        onGutterUtilityClick: (range) => {
          if (!target.comments || !target.fileId) return;
          target.comments.dispatch({
            type: "open-composer",
            fileId: target.fileId,
            selection: reviewSelection(range),
          });
        },
        renderAnnotation: (annotation) => {
          if (!target.comments || !target.fileId) return undefined;
          const element = new ReviewCommentThread();
          element.comments = target.comments;
          element.fileId = target.fileId;
          element.placementId = annotation.metadata;
          return element;
        },
        onPostRender: (node, instance, phase) => {
          if (phase === "unmount" || node.shadowRoot?.querySelector("[data-placeholder]")) return;
          const root = node.shadowRoot;
          if (root && root !== listeningRoot) {
            listeningRoot?.removeEventListener("click", handleClick, true);
            listeningRoot?.removeEventListener("keydown", handleKeydown, true);
            listeningRoot = root;
            root.addEventListener("click", handleClick, true);
            root.addEventListener("keydown", handleKeydown, true);
          }
          prepareNativeControls(root, target.fileDiff);
          if (instance instanceof PierreReviewFileDiff) {
            onNativeState?.(instance.nativeExpansionState());
          }
          rendered();
        },
      }, workerManager === null ? undefined : workerManager ?? getPierreWorkerPool());
      renderer.setInteractionCleanup(() => {
        listeningRoot?.removeEventListener("click", handleClick, true);
        listeningRoot?.removeEventListener("keydown", handleKeydown, true);
        listeningRoot = null;
      });
      renderer.restoreNativeExpansion(target.nativeExpandedHunks);
      if (target.initialExpansion) {
        const interaction = target.initialExpansion;
        const mutate = () => renderer.expandHunk(
          interaction.hunkIndex,
          interaction.direction,
          interaction.lineCount,
        );
        if (onNativeInteraction) {
          onNativeInteraction(interaction, mutate, () => expansionAnchorTop(listeningRoot, interaction));
        } else {
          mutate();
        }
      }
      return renderer;
    },
    render: (renderer, target, container) => renderer.render({
      // Never mark patch-only arrays complete: Pierre and Shiki use complete
      // hunk positions to index lines whenever isPartial is false. The normal
      // unmanaged FileDiff owns a nested <diffs-container>; Lit owns only this
      // stable wrapper, so cleanup cannot remove Lit's mount.
      fileDiff: target.fileDiff,
      containerWrapper: container,
      lineAnnotations: commentAnnotations(target),
    }),
    sameInput: (left, right) => left === right,
    onRendered,
  });
}

function commentAnnotations(
  target: ReviewFileDiffTarget,
): DiffLineAnnotation<PierreCommentPlacementMetadata>[] {
  if (!target.comments || !target.fileId) return [];
  return target.comments.project(target.fileId).placements.map((placement) => ({
    side: placement.side === "old" ? "deletions" : "additions",
    lineNumber: placement.lineNumber,
    metadata: placement.id,
  }));
}

function commentSelection(target: ReviewFileDiffTarget): SelectedLineRange | null {
  if (!target.comments || !target.fileId) return null;
  const selection = target.comments.project(target.fileId).selection;
  if (!selection) return null;
  const side = selection.side === "old" ? "deletions" : "additions";
  return { start: selection.startLine, end: selection.endLine, side, endSide: side };
}

function reviewSelection(range: SelectedLineRange): ReviewLineSelection {
  const side = range.side === "deletions" ? "old" : "new";
  const endSide = (range.endSide ?? range.side) === "deletions" ? "old" : "new";
  return { side, startLine: range.start, endLine: range.end, endSide };
}

function prepareNativeControls(root: ShadowRoot | null, fileDiff: FileDiffMetadata): void {
  if (!root) return;
  for (const control of root.querySelectorAll<HTMLElement>("[data-expand-button][role='button']")) {
    control.tabIndex = 0;
    if (control.hasAttribute("aria-label")) continue;
    const action = control.hasAttribute("data-expand-all-button")
      ? "Expand all unchanged lines"
      : control.hasAttribute("data-expand-up")
        ? "Expand unchanged lines above"
        : control.hasAttribute("data-expand-down")
          ? "Expand unchanged lines below"
          : "Expand unchanged lines";
    control.setAttribute("aria-label", action);
  }

  if (!fileDiff.isPartial) return;
  for (const content of root.querySelectorAll<HTMLElement>("[data-separator-content]")) {
    const separator = content.closest<HTMLElement>("[data-separator]");
    if (!separator || separator.dataset.expandIndex) continue;
    const nextLineIndex = nextRenderedLineIndex(separator);
    const hunkIndex = fileDiff.hunks.findIndex((hunk) => hunk.unifiedLineStart === nextLineIndex);
    if (hunkIndex < 0 || (fileDiff.hunks[hunkIndex]?.collapsedBefore ?? 0) <= 0) continue;

    // Pierre intentionally omits buttons for partial metadata. Keep its
    // structural expansion attributes untouched so the existing line-info
    // content retains Pierre's full-width layout. Reins owns only this first
    // acquisition marker; complete metadata uses Pierre's native controls.
    const direction = hunkIndex === 0 ? "down" : "both";
    content.dataset.reinsAcquireHunkIndex = `${hunkIndex}`;
    content.dataset.reinsAcquireDirection = direction;
    content.setAttribute("role", "button");
    content.tabIndex = 0;
    content.setAttribute("aria-label", "Expand unchanged lines");
    // Complete separators get this joined edge from Pierre's data-expand-index
    // selector. Keep partial metadata truthful and reproduce only that styling.
    content.style.borderTopLeftRadius = "0px";
    content.style.borderBottomLeftRadius = "0px";
    if (content.dataset.reinsAcquireButtonPrepared === undefined) {
      content.dataset.reinsAcquireButtonPrepared = "";
      content.before(createAcquisitionButton(content.ownerDocument, hunkIndex, direction));
    }
  }
}

function createAcquisitionButton(
  document: Document,
  hunkIndex: number,
  direction: "down" | "both",
): HTMLElement {
  const button = document.createElement("div");
  button.setAttribute("role", "button");
  button.setAttribute("data-expand-button", "");
  button.setAttribute(direction === "down" ? "data-expand-down" : "data-expand-both", "");
  button.setAttribute(
    "aria-label",
    direction === "down" ? "Expand unchanged lines above" : "Expand unchanged lines",
  );
  button.dataset.reinsAcquireHunkIndex = `${hunkIndex}`;
  button.dataset.reinsAcquireDirection = direction;
  button.tabIndex = 0;

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("data-icon", "");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", direction === "both" ? "#diffs-icon-expand-all" : "#diffs-icon-expand");
  icon.appendChild(use);
  button.appendChild(icon);
  return button;
}

function nextRenderedLineIndex(separator: HTMLElement): number {
  let nextLine = separator.nextElementSibling;
  while (nextLine instanceof HTMLElement) {
    const lineIndex = Number.parseInt(nextLine.dataset.lineIndex?.split(",")[0] ?? "", 10);
    if (!Number.isNaN(lineIndex)) return lineIndex;
    nextLine = nextLine.nextElementSibling;
  }
  return Number.NaN;
}

function expansionAnchorTop(
  root: ShadowRoot | null,
  interaction: ReviewFileExpansionInteraction,
): number | null {
  if (!root) return null;
  const separator = root.querySelector<HTMLElement>(`[data-expand-index="${interaction.hunkIndex}"]`);
  const anchoredLine = interaction.anchorLineNumber == null
    ? null
    : root.querySelector<HTMLElement>(`[data-column-number="${interaction.anchorLineNumber}"]`);
  return (separator ?? anchoredLine)?.getBoundingClientRect().top ?? null;
}

function expansionInteraction(event: Event): ReviewFileExpansionInteraction | null {
  const path = event.composedPath();
  const nativeControl = path.find((entry): entry is HTMLElement => (
    entry instanceof HTMLElement
      && (entry.hasAttribute("data-expand-button") || entry.dataset.reinsAcquireHunkIndex !== undefined)
  )) ?? path.find((entry): entry is HTMLElement => (
    entry instanceof HTMLElement && entry.hasAttribute("data-unmodified-lines")
  ));
  if (!nativeControl) return null;
  const separator = nativeControl.closest<HTMLElement>("[data-separator]");
  if (!separator) return null;

  const hunkIndex = Number.parseInt(
    separator.dataset.expandIndex ?? nativeControl.dataset.reinsAcquireHunkIndex ?? "",
    10,
  );
  if (Number.isNaN(hunkIndex)) return null;
  let direction: ExpansionDirections = nativeControl.dataset.reinsAcquireDirection === "down"
    || (nativeControl.hasAttribute("data-unmodified-lines") && hunkIndex === 0)
    ? "down"
    : "both";
  if (nativeControl.hasAttribute("data-expand-up")) direction = "up";
  else if (nativeControl.hasAttribute("data-expand-down")) direction = "down";
  const expandAll = nativeControl.hasAttribute("data-expand-all-button")
    || ("shiftKey" in event && event.shiftKey === true);
  if (expandAll) direction = "both";

  let nextLine = separator.nextElementSibling;
  while (nextLine instanceof HTMLElement && !nextLine.hasAttribute("data-column-number")) {
    nextLine = nextLine.nextElementSibling;
  }
  const anchorLine = nextLine instanceof HTMLElement ? nextLine : null;
  const anchorLineNumber = anchorLine
    ? Number.parseInt(anchorLine.dataset.columnNumber ?? "", 10)
    : Number.NaN;
  return {
    hunkIndex,
    direction,
    ...(expandAll ? { lineCount: Number.POSITIVE_INFINITY } : {}),
    anchorTop: separator.getBoundingClientRect().top,
    anchorLineNumber: Number.isNaN(anchorLineNumber) ? null : anchorLineNumber,
    anchorLineTop: anchorLine?.getBoundingClientRect().top ?? null,
  };
}
