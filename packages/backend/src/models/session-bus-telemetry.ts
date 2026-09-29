/**
 * Dev-only `session-bus` diagnostics for live node session events.
 *
 * Every relayed `session.event` is aggregated in memory and exported as at
 * most one `session-bus` / `window` record per window (1s by default) into the
 * shared diagnostics log, next to the browser's `streaming` windows. Emission
 * cadence (the node's `emittedAt`) against arrival cadence (server receipt)
 * tells whether bursts leave the node already bunched or are bunched in
 * transit. See docs/dev/client-telemetry.md for the attributes.
 */

import { addToStat, Cadence, emptyStat, roundMs, statAttributes, TelemetryWindow, type Stat, type TelemetryRecorder } from "@reins/telemetry";
import { serverTelemetry } from "./server-telemetry.js";

/** Node-to-server transit above this counts as slow. */
export const SLOW_TRANSIT_MS = 50;
/** A session idle this long starts fresh cadence tracking. */
const SESSION_IDLE_MS = 10_000;

interface SessionBusTelemetryOptions {
  recorder: TelemetryRecorder;
  /** Monotonic clock for arrival cadence and relay duration. */
  now?: () => number;
  /** Wall clock, comparable with the node's `emittedAt`. */
  wallNow?: () => number;
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => void;
}

export interface RelayedSessionEvent {
  sessionId: string;
  missed: number;
  emittedAt: number;
  bytes: number;
  /** `now()` when the server's handler received the event, before relaying it. */
  receivedAt: number;
  clients: number;
}

interface SessionCadence { emitted: Cadence; arrived: Cadence }

interface BusWindow {
  sessions: Set<string>;
  events: number;
  bytes: number;
  missed: number;
  clientsMax: number;
  emitGapMs: Stat;
  arrivalGapMs: Stat;
  emitBurstMax: number;
  arrivalBurstMax: number;
  transitMs: Stat;
  transitSlowCount: number;
  relayMs: Stat;
}

export class SessionBusTelemetry {
  readonly now: () => number;
  private readonly recorder: TelemetryRecorder;
  private readonly wallNow: () => number;
  private readonly windows: TelemetryWindow<BusWindow>;
  private readonly cadences = new Map<string, SessionCadence>();

  constructor(options: SessionBusTelemetryOptions) {
    this.recorder = options.recorder;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.windows = new TelemetryWindow({
      now: this.now,
      windowMs: options.windowMs,
      setTimer: options.setTimer ?? ((callback, delayMs) => { setTimeout(callback, delayMs).unref(); }),
      open: () => ({
        sessions: new Set(),
        events: 0,
        bytes: 0,
        missed: 0,
        clientsMax: 0,
        emitGapMs: emptyStat(),
        arrivalGapMs: emptyStat(),
        emitBurstMax: 0,
        arrivalBurstMax: 0,
        transitMs: emptyStat(),
        transitSlowCount: 0,
        relayMs: emptyStat(),
      }),
      close: (window, durationMs) => this.export(window, durationMs),
    });
  }

  get enabled(): boolean {
    return this.recorder.enabled;
  }

  /** Record one event after it was relayed to browsers; relay duration runs from `receivedAt` to now. */
  relayed(event: RelayedSessionEvent): void {
    if (!this.enabled) return;
    const relayedAt = this.now();
    const window = this.windows.active();
    window.sessions.add(event.sessionId);
    window.events += 1;
    window.bytes += event.bytes;
    window.missed += event.missed;
    window.clientsMax = Math.max(window.clientsMax, event.clients);
    const transit = this.wallNow() - event.emittedAt;
    addToStat(window.transitMs, transit);
    if (transit > SLOW_TRANSIT_MS) window.transitSlowCount += 1;
    addToStat(window.relayMs, relayedAt - event.receivedAt);

    let cadence = this.cadences.get(event.sessionId);
    if (!cadence) {
      cadence = { emitted: new Cadence(), arrived: new Cadence() };
      this.cadences.set(event.sessionId, cadence);
    }
    const emitGap = cadence.emitted.advance(event.emittedAt);
    const arrivalGap = cadence.arrived.advance(event.receivedAt);
    if (emitGap !== null) addToStat(window.emitGapMs, emitGap);
    if (arrivalGap !== null) addToStat(window.arrivalGapMs, arrivalGap);
    window.emitBurstMax = Math.max(window.emitBurstMax, cadence.emitted.run);
    window.arrivalBurstMax = Math.max(window.arrivalBurstMax, cadence.arrived.run);
  }

  /** Export the current window, if any. Called automatically when a window elapses. */
  flushWindow(): void {
    this.windows.flush();
  }

  private export(window: BusWindow, durationMs: number): void {
    const now = this.now();
    for (const [sessionId, cadence] of this.cadences) {
      if (now - (cadence.arrived.last ?? now) > SESSION_IDLE_MS) this.cadences.delete(sessionId);
    }
    this.recorder.record("session-bus", "window", {
      windowMs: roundMs(durationMs),
      sessions: window.sessions.size,
      events: window.events,
      bytes: window.bytes,
      missed: window.missed,
      clientsMax: window.clientsMax,
      ...statAttributes("emitGap", window.emitGapMs),
      ...statAttributes("arrivalGap", window.arrivalGapMs),
      emitBurstMax: window.emitBurstMax,
      arrivalBurstMax: window.arrivalBurstMax,
      ...statAttributes("transit", window.transitMs),
      transitSlowCount: window.transitSlowCount,
      ...statAttributes("relay", window.relayMs),
    });
  }
}

export const sessionBusTelemetry = new SessionBusTelemetry({ recorder: serverTelemetry });
