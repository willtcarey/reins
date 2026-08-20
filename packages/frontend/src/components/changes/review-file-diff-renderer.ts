import { FileDiff, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
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
  disableFileHeader: true,
};

export function createReviewFileDiffRenderer(
  host: ReactiveControllerHost,
  onRendered?: () => void,
) {
  return new PierreRenderer<FileDiffMetadata, FileDiff<undefined>>(host, {
    create: (_fileDiff, rendered) => new FileDiff({
      ...REINS_DIFF_OPTIONS,
      onPostRender: (node, _instance, phase) => {
        if (phase === "unmount" || node.shadowRoot?.querySelector("[data-placeholder]")) return;
        rendered();
      },
    }, getPierreWorkerPool(), true),
    render: (renderer, fileDiff, container) => renderer.render({ fileDiff, fileContainer: container }),
    onRendered,
  });
}
