import type { ChangeTypes } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { springCollapse } from "../../directives/spring-collapse.js";
import {
  type FileDiffContextSnapshot,
  FileDiffContextState,
} from "../../models/changes/file-diff-context-state.js";
import type { FileChange } from "../../models/changes/file-changes.js";
import { clientTelemetry } from "../../models/client-telemetry.js";
import {
  addedFileIcon,
  deletedFileIcon,
  modifiedFileIcon,
  renamedFileIcon,
} from "../icons.js";
import "./diff-file-action-buttons.js";
import {
  createReviewFileDiffRenderer,
  type ReviewFileDiffTarget,
  type ReviewFileExpansionInteraction,
} from "./review-file-diff-renderer.js";

const STATUS_ICON_DETAILS: Record<ChangeTypes, {
  label: string;
  colorClass: string;
  icon: typeof modifiedFileIcon;
}> = {
  change: {
    label: "Modified file",
    colorClass: "text-sky-400",
    icon: modifiedFileIcon,
  },
  new: {
    label: "Added file",
    colorClass: "text-green-500",
    icon: addedFileIcon,
  },
  deleted: {
    label: "Deleted file",
    colorClass: "text-red-400",
    icon: deletedFileIcon,
  },
  "rename-pure": {
    label: "Renamed file",
    colorClass: "text-violet-400",
    icon: renamedFileIcon,
  },
  "rename-changed": {
    label: "Renamed file",
    colorClass: "text-violet-400",
    icon: renamedFileIcon,
  },
};

function renderStatusIcon(status: ChangeTypes) {
  const details = STATUS_ICON_DETAILS[status];
  return details.icon(`h-3 w-3 shrink-0 ${details.colorClass}`, details.label);
}

export type ReviewFileDiffHeightChange =
  | { kind: "measurement"; height: number }
  | { kind: "transition"; bodyHeight: number; settled: boolean };

@customElement("review-file-diff")
export class ReviewFileDiff extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) change: FileChange | null = null;
  @property({ type: Boolean }) collapsed = false;
  @property({ type: Number, attribute: false }) projectId: number | null = null;
  @property({ attribute: false }) branch: string | null = null;
  @property({ type: Number, attribute: false }) reservedHeight = 0;

  private _contextState: FileDiffContextState | null = null;
  private _unsubscribeContext: (() => void) | null = null;

  @property({ attribute: false })
  get contextState(): FileDiffContextState | null {
    return this._contextState;
  }

  set contextState(value: FileDiffContextState | null) {
    const previous = this._contextState;
    if (value === previous) return;
    this._unsubscribeContext?.();
    this._unsubscribeContext = null;
    this._contextState = value;
    this._subscribeContext();
    this.requestUpdate("contextState", previous);
  }

  @property({ attribute: false }) onToggleCollapse: ((id: string) => void) | null = null;
  @property({ attribute: false }) onHeightChange:
    ((change: FileChange, update: ReviewFileDiffHeightChange) => void) | null = null;
  @property({ attribute: false }) onContextExpansion:
    ((
      change: FileChange,
      interaction: ReviewFileExpansionInteraction,
      mutate: () => void,
      resolveAnchor: () => number | null,
    ) => void) | null = null;

  private readonly _diff = createReviewFileDiffRenderer(
    this,
    undefined,
    (interaction) => this._requestAcquisition(interaction),
    (interaction, mutate, resolveAnchor) => this._expandContext(interaction, mutate, resolveAnchor),
    (regions) => this._retainNativeExpansion(regions),
  );
  private _pendingExpansion: (ReviewFileExpansionInteraction & { operationId: string }) | null = null;
  private _activeExpansionOperationId: string | null = null;
  private _targetFileDiff: FileChange["fileDiff"] | null = null;
  private _target: ReviewFileDiffTarget | null = null;
  private _transitioning = false;
  private _lastMeasurement = "";

  public get diffRendered(): boolean {
    return this.isConnected && this._diff.container !== null && this._diff.rendered;
  }

  override connectedCallback() {
    this._lastMeasurement = "";
    this._subscribeContext();
    super.connectedCallback();
  }

  override updated() {
    this._emitMeasurement();
  }

  override disconnectedCallback() {
    this._unsubscribeContext?.();
    this._unsubscribeContext = null;
    this._lastMeasurement = "";
    super.disconnectedCallback();
  }

  private _subscribeContext() {
    if (!this.isConnected || !this._contextState || this._unsubscribeContext) return;
    this._unsubscribeContext = this._contextState.subscribe((changeId) => {
      if (changeId === this.change?.id) this.requestUpdate();
    });
  }

  private _emitMeasurement() {
    const change = this.change;
    if (!change || this.collapsed || this._transitioning || !this.diffRendered) return;
    const height = this.getBoundingClientRect().height || this.offsetHeight;
    if (height <= 0) return;
    const signature = `${change.id}:${change.contentKey}:${height}`;
    if (signature === this._lastMeasurement) return;
    this._lastMeasurement = signature;
    clientTelemetry.record("review-virtualizer", "item-measurement", {
      itemId: change.id,
      operationId: this._activeExpansionOperationId,
      measuredHeight: Math.round(height),
      reservedHeight: Math.round(this.reservedHeight),
    });
    this.onHeightChange?.(change, { kind: "measurement", height });
    this._activeExpansionOperationId = null;
  }

  private _fileUrl(path: string): string {
    if (this.projectId == null) return "";
    let url = `/api/projects/${this.projectId}/files/content?path=${encodeURIComponent(path)}`;
    if (this.branch) url += `&ref=${encodeURIComponent(this.branch)}`;
    return url;
  }

  private _toggleCollapsed() {
    if (!this.change) return;
    this.onToggleCollapse?.(this.change.id);
  }

  private _reportTransitionHeight(bodyHeight: number, settled: boolean) {
    this._transitioning = !settled;
    if (this.change) this.onHeightChange?.(this.change, { kind: "transition", bodyHeight, settled });
    if (settled && !this.collapsed) queueMicrotask(() => this._emitMeasurement());
  }

  private _requestAcquisition(interaction: ReviewFileExpansionInteraction) {
    if (!this.change) return;
    const outcome = this._expansion()?.outcome;
    if (outcome !== "idle" && outcome !== "loading") return;
    this._beginExpansion(interaction, "acquisition");
    this._recordExpansion("acquisition-state", {
      outcome,
      willRequest: outcome === "idle",
    });
    if (outcome === "idle" && this.contextState) void this.contextState.acquire(this.change);
  }

  private _beginExpansion(
    interaction: ReviewFileExpansionInteraction,
    source: "native" | "acquisition" = "native",
  ) {
    const operation = clientTelemetry.startOperation("review-expansion");
    this._activeExpansionOperationId = operation.id;
    this._pendingExpansion = { ...interaction, operationId: operation.id };
    operation.record("interaction-captured", {
      source,
      itemId: this.change?.id ?? null,
      path: this.change?.path ?? null,
      hunkIndex: interaction.hunkIndex,
      direction: interaction.direction,
      requestedLineCount: interaction.lineCount === Number.POSITIVE_INFINITY
        ? "all"
        : interaction.lineCount ?? 15,
      separatorTop: Math.round(interaction.anchorTop),
      anchorLineNumber: interaction.anchorLineNumber,
      anchorLineTop: rounded(interaction.anchorLineTop),
    });
  }

  private _retainNativeExpansion(regions: ReadonlyMap<number, { fromStart: number; fromEnd: number }>) {
    if (!this.change || !this.contextState || regions.size === 0) return;
    this.contextState.retainNativeExpansion(this.change, regions);
  }

  private _expandContext(
    interaction: ReviewFileExpansionInteraction,
    mutate: () => void,
    resolveAnchor: () => number | null,
  ) {
    const change = this.change;
    if (!change) {
      mutate();
      return;
    }
    this._beginExpansion(interaction);
    if (this.onContextExpansion) {
      this.onContextExpansion(change, interaction, mutate, resolveAnchor);
    } else {
      mutate();
    }
    this._pendingExpansion = null;
  }

  private _recordExpansion(
    event: string,
    attributes: Record<string, unknown>,
    operationId = this._pendingExpansion?.operationId ?? this._activeExpansionOperationId,
  ) {
    clientTelemetry.record("review-expansion", event, {
      ...attributes,
      operationId,
      itemId: this.change?.id ?? null,
    });
  }

  private _unmountDiff() {
    this._diff.unmount();
    // A collapsed body can outlive native expansion updates in FileDiffContextState.
    // Rebuild the target on remount so its retained Pierre regions are current.
    this._targetFileDiff = null;
    this._target = null;
  }

  private _expansion(): FileDiffContextSnapshot | null {
    return this.change && this.contextState ? this.contextState.forChange(this.change) : null;
  }

  private _diffTarget(change: FileChange): ReviewFileDiffTarget {
    const expansion = this._expansion();
    const fileDiff = expansion?.fileDiff ?? change.fileDiff;
    if (fileDiff !== this._targetFileDiff) {
      this._targetFileDiff = fileDiff;
      this._target = {
        fileDiff,
        nativeExpandedHunks: expansion?.nativeExpandedHunks ?? new Map(),
        initialExpansion: fileDiff.isPartial || !this._pendingExpansion
          ? null
          : {
              hunkIndex: this._pendingExpansion.hunkIndex,
              direction: this._pendingExpansion.direction,
              ...(this._pendingExpansion.lineCount === undefined
                ? {}
                : { lineCount: this._pendingExpansion.lineCount }),
              anchorTop: this._pendingExpansion.anchorTop,
              anchorLineNumber: this._pendingExpansion.anchorLineNumber,
              ...(this._pendingExpansion.anchorLineTop === undefined
                ? {}
                : { anchorLineTop: this._pendingExpansion.anchorLineTop }),
            },
      };
    }
    return this._target!;
  }

  override render() {
    const change = this.change;
    if (!change) return nothing;

    const expansion = this._expansion();
    const diffTarget = this._diffTarget(change);
    const diffBinding = this._diff.bind(diffTarget);
    const pendingHeight = !this.collapsed && !this.diffRendered && this.reservedHeight > 0
      ? `min-height:${this.reservedHeight}px`
      : nothing;

    return html`
      <article class="border-b border-zinc-700/70 bg-zinc-950" style=${pendingHeight}>
        <header class="reins-diff-header sticky top-0 z-10 flex min-w-0 items-center gap-2 px-3 py-2">
          <button
            type="button"
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200"
            aria-label=${`${this.collapsed ? "Expand" : "Collapse"} ${change.path}`}
            aria-expanded=${String(!this.collapsed)}
            @click=${this._toggleCollapsed}
          >
            <span aria-hidden="true">${this.collapsed ? "▶" : "▼"}</span>
          </button>
          ${renderStatusIcon(change.status)}
          ${change.oldPath && change.oldPath !== change.path
            ? html`
                <span class="reins-diff-path min-w-0 truncate font-mono text-sm text-zinc-500" title=${change.oldPath}>
                  <bdi>${change.oldPath}</bdi>
                </span>
                <span class="shrink-0 text-xs text-zinc-500" aria-hidden="true">→</span>
              `
            : nothing}
          <span class="reins-diff-path min-w-0 flex-1 truncate font-mono text-sm text-zinc-200" title=${change.path}>
            <bdi>${change.path}</bdi>
          </span>
          ${change.additions > 0 || change.removals > 0
            ? html`
                <span class="flex shrink-0 items-center gap-2 font-mono text-xs">
                  ${change.additions > 0 ? html`<span class="text-green-400">+${change.additions}</span>` : nothing}
                  ${change.removals > 0 ? html`<span class="text-red-400">-${change.removals}</span>` : nothing}
                </span>
              `
            : nothing}
          <span class="flex shrink-0 items-center gap-1">
            <diff-view-file-button .path=${change.path} variant="header"></diff-view-file-button>
            <diff-copy-path-button .path=${change.path} variant="header"></diff-copy-path-button>
            <diff-download-file-button
              .path=${change.path}
              .href=${this._fileUrl(change.path)}
              variant="header"
            ></diff-download-file-button>
          </span>
        </header>
        ${springCollapse(
          this.collapsed,
          () => html`
            <diffs-container data-pierre-file-diff ${diffBinding}></diffs-container>
            ${expansionMessage(expansion) ? html`
              <div
                class="border-t border-zinc-800 px-3 py-1 text-xs text-zinc-500"
                role=${expansion?.outcome === "error" ? "alert" : "status"}
              >${expansionMessage(expansion)}</div>
            ` : nothing}
          `,
          {
            onUnmount: () => this._unmountDiff(),
            onHeightChange: (height, settled) => this._reportTransitionHeight(height, settled),
            animateContentResize: false,
          },
        )}
      </article>
    `;
  }
}

function expansionMessage(expansion: FileDiffContextSnapshot | null): string | null {
  if (!expansion) return null;
  if (expansion.outcome === "error") return "Unable to load complete file context.";
  if (expansion.unsupported?.reason === "binary") return "Context expansion is unavailable for binary files.";
  if (expansion.unsupported?.reason === "too_large") {
    const megabytes = expansion.unsupported.limitBytes / 1_048_576;
    return `Context expansion is unavailable for files over ${megabytes.toFixed(megabytes % 1 === 0 ? 0 : 1)} MB.`;
  }
  return null;
}

function rounded(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value);
}

declare global {
  interface HTMLElementTagNameMap {
    "review-file-diff": ReviewFileDiff;
  }
}
