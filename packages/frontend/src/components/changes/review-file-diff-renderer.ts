import {
  FileDiff,
  type DiffLineAnnotation,
  type ExpansionDirections,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import { PierreRenderer } from "../../controllers/pierre-renderer.js";
import type { InlineReviewFile } from "../../controllers/inline-review-controller.js";
import type { ReviewLineRange } from "../../models/code-review.js";
import { getPierreWorkerPool, PIERRE_SHIKI_THEME } from "../../models/changes/pierre-worker-pool.js";
import { ReviewCommentThread } from "./review-comment-thread.js";

type PierreCommentPlacementMetadata = string;

const REVIEW_COMMENT_HIGHLIGHT_CSS = `
[data-line]:has(+ [data-line-annotation]),
[data-column-number]:has(+ [data-gutter-buffer="annotation"]) {
  --diffs-line-bg: color-mix(in lab, var(--diffs-computed-diff-line-bg) 75%, var(--diffs-modified-base));
}
`;

const REINS_DIFF_OPTIONS: FileDiffOptions<PierreCommentPlacementMetadata, undefined> = {
  theme: PIERRE_SHIKI_THEME,
  themeType: "dark",
  unsafeCSS: REVIEW_COMMENT_HIGHLIGHT_CSS,
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

export interface ReviewFileExpansionCommand {
  readonly hunkIndex: number;
  readonly direction: ExpansionDirections;
  readonly lineCount?: number;
}

export interface ReviewFileDiffTarget {
  readonly fileDiff: FileDiffMetadata;
  readonly loadDiffFiles: FileDiffContentsLoader;
  readonly expansionHistory: readonly ReviewFileExpansionCommand[];
  inlineReview?: InlineReviewFile | null;
}

export class ReviewFileDiffRenderer extends PierreRenderer<
  ReviewFileDiffTarget,
  FileDiff<PierreCommentPlacementMetadata, undefined>
> {
  private target: ReviewFileDiffTarget | null = null;
  private commentElements = new Map<string, ReviewCommentThread>();

  override bind(target: ReviewFileDiffTarget) {
    this.target = target;
    return super.bind(target);
  }

  resetInlineCommentElements(): void {
    this.commentElements.clear();
  }

  trackInlineCommentElement(id: string, element: ReviewCommentThread): void {
    this.commentElements.set(id, element);
  }

  refreshInlineComments(): void {
    const target = this.target;
    const renderer = this.instance;
    if (!target || !renderer) return;
    for (const [id, element] of this.commentElements) {
      element.placement = target.inlineReview?.placements.find((placement) => placement.id === id) ?? null;
    }
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
  onExpansion?: (
    interaction: ReviewFileExpansionInteraction,
    mutate: () => void,
    resolveAnchor: () => number | null,
  ) => void,
  onHydrationReady?: (
    interaction: ReviewFileExpansionInteraction,
    resolveAnchor: () => number | null,
  ) => void,
  workerManager?: ReturnType<typeof getPierreWorkerPool> | null,
) {
  let controller: ReviewFileDiffRenderer;
  controller = new ReviewFileDiffRenderer(host, {
    create: (target, rendered) => {
      controller.resetInlineCommentElements();
      let listeningRoot: ShadowRoot | null = null;
      let pendingHydrationInteraction: ReviewFileExpansionInteraction | null = null;
      const keyboardRoots = new WeakSet<ShadowRoot>();
      const renderer = new FileDiff<PierreCommentPlacementMetadata, undefined>({
        ...REINS_DIFF_OPTIONS,
        loadDiffFiles: async (fileDiff) => {
          const files = await target.loadDiffFiles(fileDiff);
          const interaction = pendingHydrationInteraction;
          if (interaction) {
            onHydrationReady?.(
              interaction,
              () => expansionAnchorTop(listeningRoot, interaction),
            );
          }
          return files;
        },
        onLineSelected: (range) => {
          if (!target.inlineReview) return;
          if (!range) return target.inlineReview.select(null);
          const normalized = normalizePierreRange(range);
          if (typeof normalized === "string") target.inlineReview.reportError(normalized);
          else target.inlineReview.select(normalized);
        },
        onGutterUtilityClick: (range) => {
          if (!target.inlineReview) return;
          const normalized = normalizePierreRange(range);
          if (typeof normalized === "string") target.inlineReview.reportError(normalized);
          else target.inlineReview.openComposer(normalized);
        },
        renderAnnotation: (annotation) => {
          const placement = target.inlineReview?.placements.find(({ id }) => id === annotation.metadata);
          if (!placement) return undefined;
          const element = new ReviewCommentThread();
          element.placement = placement;
          controller.trackInlineCommentElement(placement.id, element);
          return element;
        },
        onPostRender: (node, _instance, phase) => {
          if (phase === "unmount" || node.shadowRoot?.querySelector("[data-placeholder]")) return;
          const root = node.shadowRoot;
          listeningRoot = root;
          if (root && !keyboardRoots.has(root)) {
            keyboardRoots.add(root);
            root.addEventListener("keydown", (event) => {
              if (!("key" in event) || (event.key !== "Enter" && event.key !== " ")) return;
              const interaction = expansionInteraction(event);
              if (!interaction) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              renderer.handleExpandHunk(
                interaction.hunkIndex,
                interaction.direction,
                interaction.lineCount,
              );
            }, true);
          }
          prepareNativeControls(root);
          syncCommentGutterUtility(root, target);
          rendered();
        },
      }, workerManager === null ? undefined : workerManager ?? getPierreWorkerPool());
      const nativeExpand = renderer.handleExpandHunk;
      renderer.handleExpandHunk = (hunkIndex, direction, lineCount) => {
        const interaction = expansionInteractionFromNative(listeningRoot, hunkIndex, direction, lineCount);
        if (target.fileDiff.isPartial) pendingHydrationInteraction = interaction;
        const mutate = () => nativeExpand(hunkIndex, direction, lineCount);
        if (onExpansion) onExpansion(
          interaction,
          mutate,
          () => expansionAnchorTop(listeningRoot, interaction),
        );
        else mutate();
      };
      // Refresh InteractionManager with the wrapped public expansion handler.
      renderer.setOptions(renderer.options);
      for (const command of target.expansionHistory) {
        renderer.expandHunk(command.hunkIndex, command.direction, command.lineCount);
      }
      const lastExpansion = target.expansionHistory.at(-1);
      if (target.fileDiff.isPartial && lastExpansion) {
        queueMicrotask(() => {
          if (controller.instance !== renderer) return;
          pendingHydrationInteraction = expansionInteractionFromNative(
            listeningRoot,
            lastExpansion.hunkIndex,
            lastExpansion.direction,
            lastExpansion.lineCount,
          );
          // The history was restored before first render. A zero-line public
          // expansion now attaches this remount to any in-flight native load.
          renderer.expandHunk(lastExpansion.hunkIndex, lastExpansion.direction, 0);
        });
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
  return controller;
}

function syncCommentGutterUtility(root: ShadowRoot | null, target: ReviewFileDiffTarget): void {
  if (!root) return;
  const composerOpen = target.inlineReview?.placements.some((placement) => placement.composer !== null) ?? false;
  for (const utility of root.querySelectorAll<HTMLElement>("[data-gutter-utility-slot]")) {
    utility.hidden = composerOpen;
  }
}

function commentAnnotations(
  target: ReviewFileDiffTarget,
): DiffLineAnnotation<PierreCommentPlacementMetadata>[] {
  return (target.inlineReview?.placements ?? []).map((placement) => ({
    side: placement.range.side === "old" ? "deletions" : "additions",
    lineNumber: placement.range.endLine,
    metadata: placement.id,
  }));
}

function commentSelection(target: ReviewFileDiffTarget): SelectedLineRange | null {
  const selection = target.inlineReview?.selection;
  if (!selection) return null;
  const side = selection.side === "old" ? "deletions" : "additions";
  return { start: selection.startLine, end: selection.endLine, side, endSide: side };
}

function normalizePierreRange(range: SelectedLineRange): ReviewLineRange | string {
  const endSide = range.endSide ?? range.side;
  if (range.side !== endSide) return "Inline comments must stay on one side of the diff.";
  return {
    side: range.side === "deletions" ? "old" : "new",
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

function prepareNativeControls(root: ShadowRoot | null): void {
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
  const nativeControl = event.composedPath().find((entry): entry is HTMLElement => (
    entry instanceof HTMLElement
      && (entry.hasAttribute("data-expand-button") || entry.hasAttribute("data-unmodified-lines"))
  ));
  if (!nativeControl) return null;
  const separator = nativeControl.closest<HTMLElement>("[data-separator]");
  const hunkIndex = Number.parseInt(separator?.dataset.expandIndex ?? "", 10);
  if (!separator || Number.isNaN(hunkIndex)) return null;
  let direction: ExpansionDirections = nativeControl.hasAttribute("data-unmodified-lines")
    && hunkIndex === 0 ? "down" : "both";
  if (nativeControl.hasAttribute("data-expand-up")) direction = "up";
  else if (nativeControl.hasAttribute("data-expand-down")) direction = "down";
  const lineCount = nativeControl.hasAttribute("data-expand-all-button")
    || (event instanceof MouseEvent && event.shiftKey)
    ? Number.POSITIVE_INFINITY
    : undefined;
  return interactionFromSeparator(separator, hunkIndex, direction, lineCount);
}

function expansionInteractionFromNative(
  root: ShadowRoot | null,
  hunkIndex: number,
  direction: ExpansionDirections,
  lineCount?: number,
): ReviewFileExpansionInteraction {
  const separator = root?.querySelector<HTMLElement>(`[data-expand-index="${hunkIndex}"]`) ?? null;
  return interactionFromSeparator(separator, hunkIndex, direction, lineCount);
}

function interactionFromSeparator(
  separator: HTMLElement | null,
  hunkIndex: number,
  direction: ExpansionDirections,
  lineCount?: number,
): ReviewFileExpansionInteraction {
  let nextLine = separator?.nextElementSibling ?? null;
  while (nextLine instanceof HTMLElement && !nextLine.hasAttribute("data-column-number")) {
    nextLine = nextLine.nextElementSibling;
  }
  const anchorLine = nextLine instanceof HTMLElement ? nextLine : null;
  const anchorLineNumber = Number.parseInt(anchorLine?.dataset.columnNumber ?? "", 10);
  return {
    hunkIndex,
    direction,
    ...(lineCount === undefined ? {} : { lineCount }),
    anchorTop: separator?.getBoundingClientRect().top ?? 0,
    anchorLineNumber: Number.isNaN(anchorLineNumber) ? null : anchorLineNumber,
    anchorLineTop: anchorLine?.getBoundingClientRect().top ?? null,
  };
}
