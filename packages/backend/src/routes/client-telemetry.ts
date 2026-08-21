import { HttpError, badRequest } from "../errors.js";
import type { RouterGroup } from "../router.js";
import { BoundedJsonlLog } from "../models/client-telemetry-log.js";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_BATCH_EVENTS = 100;
const MAX_EVENT_BYTES = 8 * 1024;

interface TelemetrySink {
  append(records: readonly unknown[]): Promise<void>;
}

interface ClientTelemetryEvent {
  timestamp: string;
  runId: string;
  sequence: number;
  scope: string;
  event: string;
  attributes?: Record<string, unknown>;
}

export const clientTelemetryLog = new BoundedJsonlLog();

export function registerClientTelemetryRoutes(
  router: RouterGroup,
  sink: TelemetrySink = clientTelemetryLog,
) {
  router.post("/api/diagnostics/client-events", async ({ req }) => {
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, "Telemetry batch too large");

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      badRequest("Invalid telemetry JSON");
    }
    if (!isObject(body) || !Array.isArray(body.events)) badRequest("Expected an events array");
    if (body.events.length === 0) badRequest("Telemetry batch is empty");
    if (body.events.length > MAX_BATCH_EVENTS) throw new HttpError(413, "Too many telemetry events");

    const receivedAt = new Date().toISOString();
    const records = body.events.map((candidate) => {
      if (!isClientTelemetryEvent(candidate)) badRequest("Invalid telemetry event");
      if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_EVENT_BYTES) {
        throw new HttpError(413, "Telemetry event too large");
      }
      return { receivedAt, ...candidate };
    });

    await sink.append(records);
    return Response.json({ accepted: records.length }, { status: 202 });
  });
}

function isClientTelemetryEvent(value: unknown): value is ClientTelemetryEvent {
  if (!isObject(value)) return false;
  return typeof value.timestamp === "string"
    && value.timestamp.length <= 40
    && !Number.isNaN(Date.parse(value.timestamp))
    && isBoundedString(value.runId, 100)
    && Number.isInteger(value.sequence)
    && Number(value.sequence) >= 0
    && isBoundedString(value.scope, 100)
    && isBoundedString(value.event, 100)
    && (value.attributes === undefined || isObject(value.attributes));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
