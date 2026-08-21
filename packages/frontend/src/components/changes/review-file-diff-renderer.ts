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
 * Pierre only emits its native line-info controls for non-partial metadata.
 * This shallow presentation copy exposes those controls while all semantic
 * decisions continue to use the original partial object. The copied metadata
 * must never be passed to expandHunk; its line arrays remain incomplete.
 */
export function metadataWithNativeExpansionControls(fileDiff: FileDiffMetadata): FileDiffMetadata {
  return fileDiff.isPartial
    ? {
        ...fileDiff,
        isPartial: false,
        cacheKey: fileDiff.cacheKey ? `${fileDiff.cacheKey}:native-expansion-controls` : undefined,
      }
    : fileDiff;
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
          // Capture before Pierre's bubbling InteractionManager. The renderer
          // sees a guarded presentation copy, but can never expand its partial
          // arrays while acquisition is idle, loading, or failed.
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
          prepareNativeControls(root);
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
      fileDiff: metadataWithNativeExpansionControls(target.fileDiff),
      fileContainer: container,
    }),
    sameInput: (left, right) => left === right,
    onRendered,
  });
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

function expansionInteraction(event: Event): ReviewFileExpansionInteraction | null {
  const path = event.composedPath();
  const nativeControl = path.find((entry): entry is HTMLElement => (
    entry instanceof HTMLElement
      && (entry.hasAttribute("data-expand-button") || entry.hasAttribute("data-unmodified-lines"))
  ));
  if (!nativeControl) return null;
  const separator = nativeControl.closest<HTMLElement>("[data-separator]");
  if (!separator) return null;

  const hunkIndex = Number.parseInt(separator.dataset.expandIndex ?? "", 10);
  if (Number.isNaN(hunkIndex)) return null;
  let direction: ExpansionDirections = "both";
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
