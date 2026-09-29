/**
 * Dev-only `streaming` diagnostics for live assistant output.
 *
 * Per-token work is aggregated in memory and exported as at most one
 * `streaming` / `window` telemetry event per window (1s by default), never one
 * event per token. See docs/dev/client-telemetry.md for the attributes.
 */

import { addToStat, Cadence, emptyStat, roundMs, statAttributes, TelemetryWindow, type Stat, type TelemetryRecorder } from "@reins/telemetry";
import { clientTelemetry } from "./client-telemetry.js";

interface StreamingTelemetryOptions {
  recorder: TelemetryRecorder;
  now?: () => number;
  windowMs?: number;
  /** Schedule the window export. */
  setTimer?: (callback: () => void, delayMs: number) => void;
  /** Run a callback after the current frame has rendered. */
  afterPaint?: (callback: () => void) => void;
}

/** One session event frame as the WebSocket delivered it. */
export interface SocketEvent {
  /** `now()` when the frame arrived, before parsing. */
  receivedAt: number;
  /** Parse plus synchronous dispatch into the stores. */
  handledMs: number;
  /** Browser wall clock minus the node's `emittedAt` once handled. */
  latencyMs: number;
  bytes: number;
}

/** One listener notification covering the streaming events applied since the last one. */
export interface StreamingFrame {
  streamIds: ReadonlySet<string>;
  events: number;
  /** `now()` when the first event of this frame was received. */
  firstReceivedAt: number;
}

interface StreamingWindow {
  streamIds: Set<string>;
  events: number;
  frames: number;
  maxEventsPerFrame: number;
  receiptToPaintMs: Stat;
  panelRenderMs: Stat;
  markdownParseMs: Stat;
  markdownTextLengthMax: number;
  markdownParsedLengthMax: number;
  socketEvents: number;
  socketBytes: number;
  socketGapMs: Stat;
  socketBurstMax: number;
  socketHandleMs: Stat;
  emitToHandledMs: Stat;
  longTaskMs: Stat;
}

const MAX_REPORTED_STREAM_IDS = 4;

export class StreamingTelemetry {
  private readonly recorder: TelemetryRecorder;
  private readonly afterPaint: (callback: () => void) => void;
  private readonly windows: TelemetryWindow<StreamingWindow>;
  private readonly socketCadence = new Cadence();
  readonly now: () => number;

  constructor(options: StreamingTelemetryOptions) {
    this.recorder = options.recorder;
    this.now = options.now ?? (() => performance.now());
    // A task queued from a frame callback runs after that frame's rendering
    // steps, so this approximates paint time.
    this.afterPaint = options.afterPaint ?? ((callback) => { setTimeout(callback, 0); });
    this.windows = new TelemetryWindow({
      now: this.now,
      windowMs: options.windowMs,
      setTimer: options.setTimer,
      open: () => ({
        streamIds: new Set(),
        events: 0,
        frames: 0,
        maxEventsPerFrame: 0,
        receiptToPaintMs: emptyStat(),
        panelRenderMs: emptyStat(),
        markdownParseMs: emptyStat(),
        markdownTextLengthMax: 0,
        markdownParsedLengthMax: 0,
        socketEvents: 0,
        socketBytes: 0,
        socketGapMs: emptyStat(),
        socketBurstMax: 0,
        socketHandleMs: emptyStat(),
        emitToHandledMs: emptyStat(),
        longTaskMs: emptyStat(),
      }),
      close: (window, durationMs) => this.export(window, durationMs),
    });
  }

  get enabled(): boolean {
    return this.recorder.enabled;
  }

  /** Record a listener notification; latency is measured after the frame paints. */
  frameNotified(frame: StreamingFrame): void {
    if (!this.enabled) return;
    const window = this.windows.active();
    for (const streamId of frame.streamIds) window.streamIds.add(streamId);
    window.events += frame.events;
    window.frames += 1;
    window.maxEventsPerFrame = Math.max(window.maxEventsPerFrame, frame.events);
    this.afterPaint(() => {
      addToStat(this.windows.active().receiptToPaintMs, this.now() - frame.firstReceivedAt);
    });
  }

  panelRendered(durationMs: number): void {
    if (!this.enabled) return;
    addToStat(this.windows.active().panelRenderMs, durationMs);
  }

  markdownParsed(durationMs: number, textLength: number, parsedLength: number): void {
    if (!this.enabled) return;
    const window = this.windows.active();
    addToStat(window.markdownParseMs, durationMs);
    window.markdownTextLengthMax = Math.max(window.markdownTextLengthMax, textLength);
    window.markdownParsedLengthMax = Math.max(window.markdownParsedLengthMax, parsedLength);
  }

  /** Record a session event frame from the WebSocket, whichever session it belongs to. */
  socketEvent(event: SocketEvent): void {
    if (!this.enabled) return;
    const window = this.windows.active();
    window.socketEvents += 1;
    window.socketBytes += event.bytes;
    addToStat(window.socketHandleMs, event.handledMs);
    addToStat(window.emitToHandledMs, event.latencyMs);
    const gap = this.socketCadence.advance(event.receivedAt);
    if (gap !== null) addToStat(window.socketGapMs, gap);
    window.socketBurstMax = Math.max(window.socketBurstMax, this.socketCadence.run);
  }

  /** Record a main-thread long task; only counted while a window is open (something is streaming). */
  longTask(durationMs: number): void {
    const window = this.windows.current;
    if (!this.enabled || !window) return;
    addToStat(window.longTaskMs, durationMs);
  }

  /** Export the current window, if any. Called automatically when a window elapses. */
  flushWindow(): void {
    this.windows.flush();
  }

  private export(window: StreamingWindow, durationMs: number): void {
    const streamIds = [...window.streamIds];
    this.recorder.record("streaming", "window", {
      windowMs: roundMs(durationMs),
      streamId: streamIds[0] ?? null,
      streamIds: streamIds.slice(0, MAX_REPORTED_STREAM_IDS).join(","),
      streamCount: streamIds.length,
      events: window.events,
      frames: window.frames,
      maxEventsPerFrame: window.maxEventsPerFrame,
      ...statAttributes("receiptToPaint", window.receiptToPaintMs),
      ...statAttributes("panelRender", window.panelRenderMs),
      ...statAttributes("markdownParse", window.markdownParseMs),
      markdownTextLengthMax: window.markdownTextLengthMax,
      markdownParsedLengthMax: window.markdownParsedLengthMax,
      socketEvents: window.socketEvents,
      socketBytes: window.socketBytes,
      ...statAttributes("socketGap", window.socketGapMs),
      socketBurstMax: window.socketBurstMax,
      ...statAttributes("socketHandle", window.socketHandleMs),
      ...statAttributes("emitToHandled", window.emitToHandledMs),
      ...statAttributes("longTask", window.longTaskMs),
    });
  }
}

export const streamingTelemetry = new StreamingTelemetry({ recorder: clientTelemetry });
observeLongTasks(streamingTelemetry);

/** Main-thread stalls explain hitches the per-component timings miss (GC, layout, other work). */
function observeLongTasks(telemetry: StreamingTelemetry): void {
  if (!telemetry.enabled || typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) telemetry.longTask(entry.duration);
  }).observe({ type: "longtask" });
}
