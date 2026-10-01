import type { TelemetryEvent, TelemetryRecorder } from "@reins/telemetry";
import { clientTelemetryLog } from "./client-telemetry-log.js";

interface Sink {
  append(records: readonly TelemetryEvent[]): Promise<void>;
}

interface ServerTelemetryOptions {
  enabled: boolean;
  sink?: Sink;
  wallNow?: () => number;
}

/**
 * The server's own development diagnostics (the counterpart of the browser's `clientTelemetry`): records
 * in the browser's envelope, under one `server-` run per process, written to the same log. Best effort:
 * a failed write drops its record.
 */
export class ServerTelemetry implements TelemetryRecorder {
  readonly enabled: boolean;
  private readonly sink: Sink;
  private readonly wallNow: () => number;
  private readonly runId = `server-${crypto.randomUUID()}`;
  private sequence = 0;

  constructor(options: ServerTelemetryOptions) {
    this.enabled = options.enabled;
    this.sink = options.sink ?? clientTelemetryLog;
    this.wallNow = options.wallNow ?? Date.now;
  }

  record(scope: string, event: string, attributes?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.sequence += 1;
    void this.sink.append([{
      timestamp: new Date(this.wallNow()).toISOString(),
      runId: this.runId,
      sequence: this.sequence,
      scope,
      event,
      ...(attributes ? { attributes } : {}),
    }]).catch(() => {});
  }
}

export const serverTelemetry = new ServerTelemetry({ enabled: process.env.REINS_DEV === "1" });
