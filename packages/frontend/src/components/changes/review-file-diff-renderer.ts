import {
  FileDiff,
  type ExpansionDirections,
  type FileDiffMetadata,
  type FileDiffOptions,
  type HunkExpansionRegion,
} from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import { PierreRenderer } from "../../controllers/pierre-renderer.js";
import { getPierreWorkerPool, PIERRE_SHIKI_THEME } from "../../models/changes/pierre-worker-pool.js";

const REINS_DIFF_OPTIONS: FileDiffOptions<undefined> = {
  theme: PIERRE_SHIKI_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  hunkSeparators: "line-info",
  expansionLineCount: 15,
  disableFileHeader: true,
};

export interface ReviewFileExpansionInteraction {
  readonly hunkIndex: number;
  readonly direction: ExpansionDirections;
  readonly lineCount?: number;
  readonly anchorTop: number;
  readonly anchorLineNumber: number | null;
}

export interface ReviewFileDiffTarget {
  readonly fileDiff: FileDiffMetadata;
  readonly nativeExpandedHunks: ReadonlyMap<number, HunkExpansionRegion>;
  readonly initialExpansion: Pick<ReviewFileExpansionInteraction, "hunkIndex" | "direction" | "lineCount"> | null;
}

/**
 * The only state adapter around FileDiff expansion. Pierre remains responsible
 * for changing, clamping, and joining expanded hunk regions.
 */
export class ReviewFileDiff extends FileDiff<undefined> {
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

export function createReviewFileDiffRenderer(
  host: ReactiveControllerHost,
  onRendered?: () => void,
  onAcquire?: (interaction: ReviewFileExpansionInteraction) => void,
  onNativeInteraction?: (interaction: ReviewFileExpansionInteraction) => void,
  onNativeState?: (regions: ReadonlyMap<number, HunkExpansionRegion>) => void,
  workerManager?: ReturnType<typeof getPierreWorkerPool> | null,
) {
  return new PierreRenderer<ReviewFileDiffTarget, ReviewFileDiff>(host, {
    create: (target, rendered) => {
      let listeningRoot: ShadowRoot | null = null;
      let renderer: ReviewFileDiff;
      const handleInteraction = (event: Event, keyboard: boolean) => {
        const interaction = expansionInteraction(event);
        if (!interaction) return;
        if (target.fileDiff.isPartial) {
          // Capture before Pierre's bubbling InteractionManager so it can
          // never expand partial arrays while acquisition is idle, loading,
          // unsupported, or failed.
          event.preventDefault();
          event.stopImmediatePropagation();
          onAcquire?.(interaction);
          return;
        }

        onNativeInteraction?.(interaction);
        if (keyboard) {
          // Pierre's native controls currently have button roles but no native
          // keyboard handler. Delegate keyboard activation to its public API.
          event.preventDefault();
          event.stopImmediatePropagation();
          renderer.expandHunk(interaction.hunkIndex, interaction.direction, interaction.lineCount);
        }
        // Pointer activation bubbles to Pierre's InteractionManager, which
        // invokes the same native expandHunk API itself.
      };
      const handleClick = (event: Event) => handleInteraction(event, false);
      const handleKeydown = (event: Event) => {
        if (!("key" in event) || (event.key !== "Enter" && event.key !== " ")) return;
        handleInteraction(event, true);
      };
      renderer = new ReviewFileDiff({
        ...REINS_DIFF_OPTIONS,
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
          if (instance instanceof ReviewFileDiff) {
            onNativeState?.(instance.nativeExpansionState());
          }
          rendered();
        },
      }, workerManager === null ? undefined : workerManager ?? getPierreWorkerPool(), true);
      renderer.setInteractionCleanup(() => {
        listeningRoot?.removeEventListener("click", handleClick, true);
        listeningRoot?.removeEventListener("keydown", handleKeydown, true);
        listeningRoot = null;
      });
      renderer.restoreNativeExpansion(target.nativeExpandedHunks);
      if (target.initialExpansion) {
        renderer.expandHunk(
          target.initialExpansion.hunkIndex,
          target.initialExpansion.direction,
          target.initialExpansion.lineCount,
        );
      }
      return renderer;
    },
    render: (renderer, target, container) => renderer.render({
      // Never mark patch-only arrays complete: Pierre and Shiki use complete
      // hunk positions to index lines whenever isPartial is false.
      fileDiff: target.fileDiff,
      fileContainer: container,
    }),
    sameInput: (left, right) => left === right,
    onRendered,
  });
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
    if (hunkIndex < 0) continue;

    // Pierre intentionally omits buttons for partial metadata. Keep its
    // structural expansion attributes untouched so the existing line-info
    // content retains Pierre's full-width layout. Reins owns only this first
    // acquisition marker; complete metadata uses Pierre's native controls.
    content.dataset.reinsAcquireHunkIndex = `${hunkIndex}`;
    content.dataset.reinsAcquireDirection = hunkIndex === 0 ? "down" : "both";
    content.setAttribute("role", "button");
    content.tabIndex = 0;
    content.setAttribute("aria-label", "Load complete file context");
  }
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
  };
}
