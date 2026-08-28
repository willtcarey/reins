import type { ChangeTypes } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { springCollapse } from "../../directives/spring-collapse.js";
import type {
  ExpansionSnapshot,
} from "../../models/changes/expansion-state.js";
import type { FileChange } from "../../models/changes/file-changes.js";
import { clientTelemetry } from "../../models/client-telemetry.js";
import {
  reviewTransitionHeightEvent,
  reviewContextAcquireEvent,
  reviewContextStateEvent,
  reviewItemMeasurementEvent,
  reviewPreserveScrollEvent,
  toggleCollapseEvent,
} from "../events.js";
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

@customElement("review-diff-item")
export class ReviewDiffItem extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) change: FileChange | null = null;
  @property({ type: Boolean }) collapsed = false;
  @property({ type: Number, attribute: false }) projectId: number | null = null;
  @property({ attribute: false }) branch: string | null = null;
  @property({ type: Number, attribute: false }) reservedHeight = 0;
  @property({ attribute: false }) expansion: ExpansionSnapshot | null = null;

  private readonly _diff = createReviewFileDiffRenderer(
    this,
    undefined,
    (interaction) => this._requestAcquisition(interaction),
    (interaction, mutate) => this._preserveExpansionScroll(interaction, mutate),
    (regions) => this._retainNativeExpansion(regions),
  );
  private _pendingExpansionAnchor: (ReviewFileExpansionInteraction & { operationId: string }) | null = null;
  private _activeExpansionOperationId: string | null = null;
  private _targetFileDiff: FileChange["fileDiff"] | null = null;
  private _target: ReviewFileDiffTarget | null = null;
  private _heightObserver: ResizeObserver | null = null;
  private _mountGeneration = 0;
  private _lastMeasurement = "";

  public get diffRendered(): boolean {
    return this._measurementReadiness().diffRendered;
  }

  override connectedCallback() {
    this._mountGeneration += 1;
    this._lastMeasurement = "";
    super.connectedCallback();
  }

  override updated() {
    this._observeHeight();
    this._emitStableMeasurement(this._mountGeneration);
  }

  override disconnectedCallback() {
    this._mountGeneration += 1;
    this._heightObserver?.disconnect();
    this._heightObserver = null;
    this._lastMeasurement = "";
    super.disconnectedCallback();
  }

  private _observeHeight() {
    if (this.collapsed) {
      this._heightObserver?.disconnect();
      this._heightObserver = null;
      return;
    }
    if (typeof ResizeObserver === "undefined" || this._heightObserver) return;
    const generation = this._mountGeneration;
    this._heightObserver = new ResizeObserver(() => this._emitStableMeasurement(generation));
    this._heightObserver.observe(this);
  }

  private _emitStableMeasurement(generation: number) {
    const change = this.change;
    if (!change || this.collapsed || generation !== this._mountGeneration) return;
    const readiness = this._measurementReadiness();
    const height = this.getBoundingClientRect().height || this.offsetHeight;
    this._recordMeasurementTelemetry(generation, height, readiness);
    if (!readiness.stable || height <= 0) return;
    const signature = `${generation}:${change.id}:${change.contentKey}:${this.collapsed}:${height}`;
    if (signature === this._lastMeasurement) return;
    this._lastMeasurement = signature;
    this.dispatchEvent(reviewItemMeasurementEvent({ id: change.id, height }));
    this._activeExpansionOperationId = null;
  }

  /** Only settled states may replace the coordinator's persistent estimate. */
  private _measurementReadiness() {
    const connected = this.isConnected && typeof this.querySelector === "function";
    const article = connected ? this.querySelector<HTMLElement>("article") : null;
    const transition = connected ? this.querySelector<HTMLElement>("[data-spring-collapse]") : null;
    const container = connected ? this.querySelector<HTMLElement>("[data-pierre-file-diff]") : null;
    const shadowRoot = container?.shadowRoot;
    const pre = shadowRoot?.querySelector<HTMLElement>("pre") ?? null;
    const placeholder = shadowRoot?.querySelector("[data-placeholder]") != null;
    const diffRendered = article?.isConnected === true
      && container !== null
      && container === this._diff.container
      && pre !== null
      && !placeholder
      && this._diff.rendered;
    const stable = article?.isConnected === true && diffRendered && !transition?.style.height;
    return { article, connected, container, diffRendered, placeholder, pre, stable, transition };
  }

  private _recordMeasurementTelemetry(
    generation: number,
    height: number,
    readiness: ReturnType<ReviewDiffItem["_measurementReadiness"]>,
  ) {
    if (!clientTelemetry.enabled) return;
    clientTelemetry.record("review-virtualizer", "item-measurement-candidate", {
      itemId: this.change?.id ?? null,
      operationId: this._activeExpansionOperationId,
      measuredHeight: Math.round(height),
      reservedHeight: Math.round(this.reservedHeight),
      stable: readiness.stable,
      diffRendered: readiness.diffRendered,
      connected: readiness.connected,
      currentGeneration: generation === this._mountGeneration,
      currentContainer: readiness.container === this._diff.container,
      collapsed: this.collapsed,
      collapseSettled: readiness.transition === null || !readiness.transition.style.height,
      articleHeight: measuredHeight(readiness.article),
      articleMinHeight: readiness.article?.style.minHeight || null,
      containerHeight: measuredHeight(readiness.container),
      shadowChildCount: readiness.container?.shadowRoot?.children.length ?? 0,
      preHeight: measuredHeight(readiness.pre),
      placeholder: readiness.placeholder,
    });
  }

  private _fileUrl(path: string): string {
    if (this.projectId == null) return "";
    let url = `/api/projects/${this.projectId}/files/content?path=${encodeURIComponent(path)}`;
    if (this.branch) url += `&ref=${encodeURIComponent(this.branch)}`;
    return url;
  }

  private _toggleCollapsed() {
    if (!this.change) return;
    this.dispatchEvent(toggleCollapseEvent(this.change.id));
  }

  private _reportTransitionHeight(bodyHeight: number, settled: boolean) {
    if (!this.change) return;
    this.dispatchEvent(reviewTransitionHeightEvent({ id: this.change.id, bodyHeight, settled }));
  }

  private _requestAcquisition(interaction: ReviewFileExpansionInteraction) {
    if (!this.change) return;
    const outcome = this.expansion?.outcome;
    if (outcome !== "idle" && outcome !== "loading") return;
    this._rememberExpansionAnchor(interaction, "acquisition");
    this._recordExpansion("acquisition-state", {
      outcome,
      willRequest: outcome === "idle",
    });
    if (outcome === "idle") this.dispatchEvent(reviewContextAcquireEvent(this.change.id));
  }

  private _rememberExpansionAnchor(
    interaction: ReviewFileExpansionInteraction,
    source: "native" | "acquisition" = "native",
  ) {
    const operation = clientTelemetry.startOperation("review-expansion");
    this._activeExpansionOperationId = operation.id;
    this._pendingExpansionAnchor = { ...interaction, operationId: operation.id };
    if (!clientTelemetry.enabled) return;
    const itemRect = typeof this.getBoundingClientRect === "function"
      ? this.getBoundingClientRect()
      : null;
    const diffContainer = this._diff.container;
    const diffRect = diffContainer && typeof diffContainer.getBoundingClientRect === "function"
      ? diffContainer.getBoundingClientRect()
      : null;
    const scroll = this._reviewScrollContainer();
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
      itemTop: rounded(itemRect?.top),
      itemHeight: rounded(itemRect?.height),
      containerTop: rounded(diffRect?.top),
      containerHeight: rounded(diffRect?.height),
      scrollTop: rounded(scroll?.scrollTop),
      viewportHeight: scroll?.clientHeight ?? null,
    });
  }

  private _retainNativeExpansion(regions: ReadonlyMap<number, { fromStart: number; fromEnd: number }>) {
    if (!this.change || regions.size === 0) return;
    this.dispatchEvent(reviewContextStateEvent({ id: this.change.id, regions }));
  }

  private _preserveExpansionScroll(
    interaction: ReviewFileExpansionInteraction,
    mutate: () => void,
  ) {
    if (!this.change) {
      mutate();
      return;
    }
    this._rememberExpansionAnchor(interaction);
    if (interaction.direction === "up") {
      this._pendingExpansionAnchor = null;
      mutate();
      return;
    }

    const anchor = interaction.direction === "down"
      ? "item-end" as const
      : () => this._expansionAnchorTop(interaction);
    this.dispatchEvent(reviewPreserveScrollEvent({ id: this.change.id, anchor, mutate }));
    this._pendingExpansionAnchor = null;
  }

  private _expansionAnchorTop(interaction: ReviewFileExpansionInteraction): number | null {
    const root = this._diff.container?.shadowRoot;
    if (!root) return null;
    const separator = root.querySelector<HTMLElement>(`[data-expand-index="${interaction.hunkIndex}"]`);
    const anchoredLine = interaction.anchorLineNumber == null
      ? null
      : root.querySelector<HTMLElement>(`[data-column-number="${interaction.anchorLineNumber}"]`);
    return (separator ?? anchoredLine)?.getBoundingClientRect().top ?? null;
  }

  private _reviewScrollContainer(): HTMLElement | null {
    if (typeof this.closest !== "function") return null;
    return this.closest("review-diff-panel")?.querySelector<HTMLElement>("[data-review-scroll]") ?? null;
  }

  private _recordExpansion(
    event: string,
    attributes: Record<string, unknown>,
    operationId = this._pendingExpansionAnchor?.operationId ?? this._activeExpansionOperationId,
  ) {
    clientTelemetry.record("review-expansion", event, {
      ...attributes,
      operationId,
      itemId: this.change?.id ?? null,
    });
  }

  private _unmountDiff() {
    this._diff.unmount();
    // A collapsed body can outlive native expansion updates in ExpansionState.
    // Rebuild the target on remount so its retained Pierre regions are current.
    this._targetFileDiff = null;
    this._target = null;
  }

  private _diffTarget(change: FileChange): ReviewFileDiffTarget {
    const fileDiff = this.expansion?.fileDiff ?? change.fileDiff;
    if (fileDiff !== this._targetFileDiff) {
      this._targetFileDiff = fileDiff;
      this._target = {
        fileDiff,
        nativeExpandedHunks: this.expansion?.nativeExpandedHunks ?? new Map(),
        initialExpansion: fileDiff.isPartial || !this._pendingExpansionAnchor
          ? null
          : {
              hunkIndex: this._pendingExpansionAnchor.hunkIndex,
              direction: this._pendingExpansionAnchor.direction,
              ...(this._pendingExpansionAnchor.lineCount === undefined
                ? {}
                : { lineCount: this._pendingExpansionAnchor.lineCount }),
              anchorTop: this._pendingExpansionAnchor.anchorTop,
              anchorLineNumber: this._pendingExpansionAnchor.anchorLineNumber,
              ...(this._pendingExpansionAnchor.anchorLineTop === undefined
                ? {}
                : { anchorLineTop: this._pendingExpansionAnchor.anchorLineTop }),
            },
      };
    }
    return this._target!;
  }

  override render() {
    const change = this.change;
    if (!change) return nothing;

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
            ${expansionMessage(this.expansion) ? html`
              <div
                class="border-t border-zinc-800 px-3 py-1 text-xs text-zinc-500"
                role=${this.expansion?.outcome === "error" ? "alert" : "status"}
              >${expansionMessage(this.expansion)}</div>
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

function expansionMessage(expansion: ExpansionSnapshot | null): string | null {
  if (!expansion) return null;
  if (expansion.outcome === "error") return "Unable to load complete file context.";
  if (expansion.unsupported?.reason === "binary") return "Context expansion is unavailable for binary files.";
  if (expansion.unsupported?.reason === "too_large") {
    const megabytes = expansion.unsupported.limitBytes / 1_048_576;
    return `Context expansion is unavailable for files over ${megabytes.toFixed(megabytes % 1 === 0 ? 0 : 1)} MB.`;
  }
  return null;
}

function measuredHeight(element: HTMLElement | null | undefined): number | null {
  return element ? Math.round(element.getBoundingClientRect().height) : null;
}

function rounded(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value);
}

declare global {
  interface HTMLElementTagNameMap {
    "review-diff-item": ReviewDiffItem;
  }
}
