export interface ClientTelemetryEvent {
  readonly timestamp: string;
  readonly runId: string;
  readonly sequence: number;
  readonly scope: string;
  readonly event: string;
  readonly attributes?: Record<string, unknown>;
}

type TelemetryAttributes = Record<string, unknown> | (() => Record<string, unknown>);

interface ClientTelemetryOptions {
  enabled: () => boolean;
  transport: (events: readonly ClientTelemetryEvent[]) => Promise<void>;
  maxQueue?: number;
  maxBatch?: number;
  flushIntervalMs?: number;
  autoFlush?: boolean;
  runId?: string;
  now?: () => string;
}

/** Bounded browser diagnostic queue. Production builds never enable it. */
export class ClientTelemetry {
  private readonly queue: ClientTelemetryEvent[] = [];
  private readonly maxQueue: number;
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly autoFlush: boolean;
  private readonly runId: string;
  private readonly now: () => string;
  private sequence = 0;
  private operationSequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly options: ClientTelemetryOptions) {
    this.maxQueue = options.maxQueue ?? 500;
    this.maxBatch = options.maxBatch ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.autoFlush = options.autoFlush ?? true;
    this.runId = options.runId ?? createRunId();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public get enabled(): boolean {
    return this.options.enabled();
  }

  public startOperation(scope: string): ClientTelemetryOperation {
    this.operationSequence += 1;
    return new ClientTelemetryOperation(this, scope, `${scope}-${this.operationSequence}`);
  }

  public record(
    scope: string,
    event: string,
    attributes?: TelemetryAttributes,
  ) {
    if (!this.enabled) return;
    const resolvedAttributes = typeof attributes === "function" ? attributes() : attributes;
    this.sequence += 1;
    if (this.queue.length === this.maxQueue) this.queue.shift();
    this.queue.push({
      timestamp: this.now(),
      runId: this.runId,
      sequence: this.sequence,
      scope,
      event,
      ...(resolvedAttributes ? { attributes: resolvedAttributes } : {}),
    });
    if (this.autoFlush && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  public flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushQueued().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushQueued() {
    while (this.queue.length > 0 && this.options.enabled()) {
      const batch = this.queue.splice(0, this.maxBatch);
      try {
        await this.options.transport(batch);
      } catch {
        this.queue.unshift(...batch);
        if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
        return;
      }
    }
  }
}

export class ClientTelemetryOperation {
  constructor(
    private readonly telemetry: ClientTelemetry,
    private readonly scope: string,
    public readonly id: string,
  ) {}

  public record(event: string, attributes?: TelemetryAttributes) {
    this.telemetry.record(this.scope, event, () => ({
      ...(typeof attributes === "function" ? attributes() : attributes),
      operationId: this.id,
    }));
  }
}

export const clientTelemetry = new ClientTelemetry({
  enabled: isDevBuild,
  transport: async (events) => {
    const response = await fetch("/api/diagnostics/client-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    if (!response.ok) throw new Error(`Telemetry export failed: ${response.status}`);
  },
});

function createRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isDevBuild(): boolean {
  return typeof REINS_DEV !== "undefined" && REINS_DEV;
}
