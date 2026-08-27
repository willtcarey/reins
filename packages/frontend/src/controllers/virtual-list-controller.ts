import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  VirtualListCoordinator,
  type VirtualListGeometryUpdate,
  type VirtualListItem,
  type VirtualListItemInput,
  type VirtualListMeasurement,
  type VirtualListWindow,
} from "../models/virtual-list-coordinator.js";

export interface VirtualListContainer {
  scrollTop: number;
  clientHeight: number;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  scrollTo(options?: ScrollToOptions | number, y?: number): void;
}

export type VirtualListScrollAnchor = "item-end" | (() => number | null);

export type VirtualListObservation =
  | {
      readonly type: "scroll";
      readonly actualTop: number;
      readonly activeId: string | null;
      readonly navigationId: string | null;
      readonly layoutVersion: number;
    }
  | {
      readonly type: "navigation-start";
      readonly targetId: string;
      readonly requestedTop: number;
      readonly actualTop: number;
      readonly replacedCorrection: number | null;
      readonly layoutVersion: number;
    }
  | {
      readonly type: "navigation-cancelled" | "navigation-complete";
      readonly targetId: string;
      readonly actualTop: number;
      readonly inputType?: string;
      readonly layoutVersion: number;
    }
  | {
      readonly type: "measurement-batch";
      readonly submitted: number;
      readonly accepted: number;
      readonly correctedTop: number;
      readonly scrollAdjustment: number;
      readonly actualTop: number | null;
      readonly measurements: readonly VirtualListMeasurement[];
      readonly layoutVersion: number;
    }
  | {
      readonly type: "geometry-queued";
      readonly reason: "navigation-retarget" | "anchor-correction";
      readonly requestedTop: number;
      readonly actualTop: number | null;
      readonly navigationId: string | null;
      readonly layoutVersion: number;
    }
  | {
      readonly type: "geometry-applied";
      readonly requestedTop: number;
      readonly actualBefore: number;
      readonly actualAfter: number;
      readonly smooth: boolean;
      readonly navigationId: string | null;
      readonly layoutVersion: number;
    }
  | {
      readonly type: "window-change";
      readonly window: VirtualListWindow;
      readonly actualTop: number | null;
      readonly layoutVersion: number;
    };

/**
 * Generic Lit behavior controller for one bounded, variable-height virtual list.
 *
 * Callers provide semantic item geometry, attach the rendered scroll container,
 * submit stable measurements, and render `window()`. The controller owns DOM
 * viewport synchronization, measurement batching, anchoring, navigation, and
 * render scheduling without knowing what an item represents.
 */
export class VirtualListController implements ReactiveController {
  public observe: ((observation: VirtualListObservation) => void) | null = null;

  private coordinator: VirtualListCoordinator;
  private container: VirtualListContainer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pendingMeasurements = new Map<string, VirtualListMeasurement>();
  private measurementFlushQueued = false;
  private generation = 0;
  private renderFrame: number | null = null;
  private pendingGeometryScrollTop: number | null = null;
  private pendingScrollPreservation: {
    itemId: string;
    anchor: VirtualListScrollAnchor;
    before: number;
    itemHeightBefore: number;
  } | null = null;
  private navigationId: string | null = null;
  private visible = false;
  private rememberedScrollTop: number | null = null;
  private restoreScrollAfterRender = false;
  private observedWindowSignature = "";

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly overscan: number,
    private viewportHeight = 800,
  ) {
    this.coordinator = new VirtualListCoordinator(overscan);
    this.coordinator.setViewport(0, viewportHeight);
    host.addController(this);
  }

  public setItems(items: readonly VirtualListItemInput[]) {
    this.syncViewport();
    this.queueGeometryUpdate(this.coordinator.setItems(items), true);
    this.host.requestUpdate();
  }

  public setItemFixedHeight(id: string, height: number): boolean {
    this.syncViewport();
    const update = this.coordinator.setItemFixedHeight(id, height);
    if (!update) return false;
    this.queueGeometryUpdate(update, true);
    this.host.requestUpdate();
    return true;
  }

  public attach(container: VirtualListContainer | null) {
    if (container === this.container) return;
    this.detachContainer();
    this.container = container;
    if (!container) return;

    container.addEventListener("scroll", this.handleScroll, { passive: true });
    container.addEventListener("wheel", this.handleScrollIntent, { passive: true });
    container.addEventListener("touchstart", this.handleScrollIntent, { passive: true });
    container.addEventListener("pointerdown", this.handleScrollIntent, { passive: true });
    container.addEventListener("keydown", this.handleScrollIntent);
    this.syncViewport();
    this.observeContainerSize(container);
    this.restoreScrollPosition();
    this.applyPendingGeometryScroll();
  }

  public setVisible(visible: boolean) {
    if (visible === this.visible) return;
    if (!visible) this.rememberScrollPosition();
    this.visible = visible;
    if (visible && this.rememberedScrollTop !== null) {
      this.restoreScrollAfterRender = true;
      this.host.requestUpdate();
    }
  }

  public measure(measurement: VirtualListMeasurement) {
    const item = this.coordinator.item(measurement.id);
    const rejectionReason = !item
      ? "missing-item"
      : item.fixedHeight !== undefined
        ? "fixed-height"
        : item.measurementKey !== measurement.measurementKey
          ? "stale-key"
          : measurement.height <= 0
            ? "non-positive-height"
            : null;
    if (rejectionReason !== null) return;

    this.pendingMeasurements.set(measurement.id, measurement);
    if (this.measurementFlushQueued) return;
    this.measurementFlushQueued = true;
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      this.measurementFlushQueued = false;
      this.commitMeasurements();
    });
  }

  /** Run an item mutation and preserve one semantic viewport point through its next measurement. */
  public preserveScroll(id: string, anchor: VirtualListScrollAnchor, mutate: () => void) {
    const item = this.coordinator.item(id);
    const before = anchor === "item-end" ? item?.height ?? null : anchor();
    if (!this.container || !item || before === null || !Number.isFinite(before)) {
      mutate();
      return;
    }

    this.pendingScrollPreservation = {
      itemId: id,
      anchor,
      before,
      itemHeightBefore: item.height,
    };
    try {
      mutate();
    } catch (error) {
      this.pendingScrollPreservation = null;
      throw error;
    }
  }

  public navigateTo(id: string): boolean {
    const top = this.coordinator.navigationTop(id);
    if (top === null || !this.container) return false;

    this.emit({
      type: "navigation-start",
      targetId: id,
      requestedTop: top,
      actualTop: this.container.scrollTop,
      replacedCorrection: this.pendingGeometryScrollTop,
      layoutVersion: this.coordinator.layoutVersion,
    });
    this.pendingGeometryScrollTop = null;
    this.navigationId = id;
    this.container.scrollTo({ top, behavior: "smooth" });
    return true;
  }

  /** Immediately align an item after an interaction changes its geometry. */
  public scrollToItemStart(id: string): boolean {
    const top = this.coordinator.navigationTop(id);
    if (top === null || !this.container) return false;

    this.pendingGeometryScrollTop = null;
    this.navigationId = null;
    this.container.scrollTop = top;
    this.coordinator.setViewport(top, this.container.clientHeight || this.viewportHeight);
    this.rememberScrollPosition();
    this.host.requestUpdate();
    return true;
  }

  public window(): VirtualListWindow {
    return this.coordinator.window();
  }

  public item(id: string): VirtualListItem | undefined {
    return this.coordinator.item(id);
  }

  public reset() {
    if (this.navigationId && this.container) {
      this.container.scrollTo({ top: this.container.scrollTop, behavior: "auto" });
    }
    this.generation += 1;
    this.pendingMeasurements.clear();
    this.measurementFlushQueued = false;
    this.pendingGeometryScrollTop = null;
    this.pendingScrollPreservation = null;
    this.navigationId = null;
    this.rememberedScrollTop = null;
    this.restoreScrollAfterRender = false;
    this.observedWindowSignature = "";
    this.coordinator = new VirtualListCoordinator(this.overscan);
    this.coordinator.setViewport(this.container?.scrollTop ?? 0, this.container?.clientHeight || this.viewportHeight);
    this.host.requestUpdate();
  }

  public hostUpdated() {
    this.restoreScrollPosition();
    this.applyPendingGeometryScroll();
    this.recordWindow();
  }

  public hostDisconnected() {
    this.detachContainer();
    if (this.renderFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.renderFrame);
    }
    this.renderFrame = null;
    this.generation += 1;
    this.pendingMeasurements.clear();
    this.measurementFlushQueued = false;
    this.pendingScrollPreservation = null;
  }

  private handleScroll = () => {
    if (!this.container) return;
    if (this.container.clientHeight > 0) this.viewportHeight = this.container.clientHeight;
    this.coordinator.setViewport(this.container.scrollTop, this.viewportHeight);
    this.rememberScrollPosition();
    const activeId = this.coordinator.window().activeId;
    this.emit({
      type: "scroll",
      actualTop: this.container.scrollTop,
      activeId,
      navigationId: this.navigationId,
      layoutVersion: this.coordinator.layoutVersion,
    });

    const navigationId = this.navigationId;
    const navigationTop = navigationId ? this.coordinator.navigationTop(navigationId) : null;
    if (navigationId && navigationTop !== null && Math.abs(this.container.scrollTop - navigationTop) <= 1) {
      this.navigationId = null;
      this.emit({
        type: "navigation-complete",
        targetId: navigationId,
        actualTop: this.container.scrollTop,
        layoutVersion: this.coordinator.layoutVersion,
      });
    }
    this.scheduleRender();
  };

  private handleScrollIntent = (event: Event) => {
    if (!this.isScrollIntent(event)) return;
    this.pendingScrollPreservation = null;
    this.pendingGeometryScrollTop = null;
    if (!this.navigationId) return;
    const targetId = this.navigationId;
    this.navigationId = null;
    this.emit({
      type: "navigation-cancelled",
      targetId,
      inputType: event.type,
      actualTop: this.container?.scrollTop ?? 0,
      layoutVersion: this.coordinator.layoutVersion,
    });
    if (this.container) this.container.scrollTo({ top: this.container.scrollTop, behavior: "auto" });
  };

  private isScrollIntent(event: Event): boolean {
    if (event.type !== "keydown") return true;
    const key = "key" in event && typeof event.key === "string" ? event.key : "";
    return ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key);
  }

  private scheduleRender() {
    if (this.renderFrame !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      this.host.requestUpdate();
      return;
    }
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.host.requestUpdate();
    });
  }

  private commitMeasurements() {
    this.syncViewport();
    const measurements = [...this.pendingMeasurements.values()];
    this.pendingMeasurements.clear();
    const preservation = this.pendingScrollPreservation;
    const measuredUpdate = this.coordinator.measure(measurements);
    const itemHeightAfter = preservation ? this.coordinator.item(preservation.itemId)?.height : undefined;
    const targetChanged = preservation !== null
      && measurements.some((measurement) => measurement.id === preservation.itemId)
      && itemHeightAfter !== undefined
      && itemHeightAfter !== preservation.itemHeightBefore;
    const pointAdjustment = targetChanged && typeof preservation.anchor === "function"
      ? (preservation.anchor() ?? preservation.before) - preservation.before
      : 0;
    const growthAdjustment = targetChanged && preservation.anchor === "item-end"
      ? itemHeightAfter! - preservation.itemHeightBefore
      : 0;
    const interactionAdjustment = pointAdjustment + growthAdjustment;
    if (targetChanged) this.pendingScrollPreservation = null;
    const update = interactionAdjustment === 0
      ? measuredUpdate
      : {
          ...measuredUpdate,
          scrollTop: measuredUpdate.scrollTop + interactionAdjustment,
          scrollAdjustment: measuredUpdate.scrollAdjustment + interactionAdjustment,
        };
    this.emit({
      type: "measurement-batch",
      submitted: measurements.length,
      accepted: update.accepted,
      correctedTop: update.scrollTop,
      scrollAdjustment: update.scrollAdjustment,
      actualTop: this.container?.scrollTop ?? null,
      measurements,
      layoutVersion: this.coordinator.layoutVersion,
    });
    // Absolute item positions must repaint even when the semantic anchor means
    // the changed geometry requires no scroll correction.
    if (update.accepted > 0) this.host.requestUpdate();
    this.queueGeometryUpdate(update, update.accepted > 0);
  }

  private queueGeometryUpdate(update: VirtualListGeometryUpdate, geometryChanged: boolean) {
    let reason: "navigation-retarget" | "anchor-correction";
    if (this.navigationId && geometryChanged) {
      const navigationTop = this.coordinator.navigationTop(this.navigationId);
      if (navigationTop === null) {
        this.navigationId = null;
        return;
      }
      this.pendingGeometryScrollTop = navigationTop;
      reason = "navigation-retarget";
    } else if (update.scrollAdjustment !== 0) {
      this.pendingGeometryScrollTop = update.scrollTop;
      reason = "anchor-correction";
    } else {
      return;
    }
    this.emit({
      type: "geometry-queued",
      reason,
      requestedTop: this.pendingGeometryScrollTop,
      actualTop: this.container?.scrollTop ?? null,
      navigationId: this.navigationId,
      layoutVersion: this.coordinator.layoutVersion,
    });
    this.host.requestUpdate();
  }

  private applyPendingGeometryScroll() {
    if (this.pendingGeometryScrollTop === null) return;
    const top = this.pendingGeometryScrollTop;
    const container = this.container;
    if (!container) return;
    this.pendingGeometryScrollTop = null;
    const actualBefore = container.scrollTop;
    const navigationId = this.navigationId;
    if (navigationId) container.scrollTo({ top, behavior: "smooth" });
    else container.scrollTop = top;
    this.coordinator.setViewport(container.scrollTop, container.clientHeight || this.viewportHeight);
    this.emit({
      type: "geometry-applied",
      requestedTop: top,
      actualBefore,
      actualAfter: container.scrollTop,
      smooth: navigationId !== null,
      navigationId,
      layoutVersion: this.coordinator.layoutVersion,
    });
  }

  private syncViewport() {
    if (!this.container) return;
    if (this.container.clientHeight > 0) this.viewportHeight = this.container.clientHeight;
    this.coordinator.setViewport(this.container.scrollTop, this.viewportHeight);
  }

  private rememberScrollPosition() {
    if (!this.visible || !this.container || this.container.clientHeight <= 0) return;
    this.rememberedScrollTop = this.container.scrollTop;
  }

  private restoreScrollPosition() {
    if (!this.restoreScrollAfterRender || !this.visible || !this.container) return;
    if (this.container.clientHeight <= 0 || this.rememberedScrollTop === null) return;
    this.restoreScrollAfterRender = false;
    this.container.scrollTop = this.rememberedScrollTop;
    this.syncViewport();
    this.host.requestUpdate();
  }

  private observeContainerSize(container: VirtualListContainer) {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.container !== container) return;
      const height = entries.at(-1)?.contentRect.height ?? 0;
      if (height <= 0 || height === this.viewportHeight) return;
      this.viewportHeight = height;
      this.coordinator.setViewport(this.container?.scrollTop ?? 0, height);
      this.host.requestUpdate();
    });
    if (typeof Element !== "undefined" && container instanceof Element) {
      this.resizeObserver.observe(container);
    }
  }

  private detachContainer() {
    if (this.container) {
      this.container.removeEventListener("scroll", this.handleScroll);
      this.container.removeEventListener("wheel", this.handleScrollIntent);
      this.container.removeEventListener("touchstart", this.handleScrollIntent);
      this.container.removeEventListener("pointerdown", this.handleScrollIntent);
      this.container.removeEventListener("keydown", this.handleScrollIntent);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.container = null;
  }

  private recordWindow() {
    const window = this.coordinator.window();
    const firstId = window.items[0]?.id ?? "";
    const lastId = window.items.at(-1)?.id ?? "";
    const signature = `${this.coordinator.layoutVersion}:${firstId}:${lastId}:${window.totalHeight}`;
    if (signature === this.observedWindowSignature) return;
    this.observedWindowSignature = signature;
    this.emit({
      type: "window-change",
      window,
      actualTop: this.container?.scrollTop ?? null,
      layoutVersion: this.coordinator.layoutVersion,
    });
  }

  private emit(observation: VirtualListObservation) {
    this.observe?.(observation);
  }
}
