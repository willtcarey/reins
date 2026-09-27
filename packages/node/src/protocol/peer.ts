import { z } from "zod";

export interface WireSocket { send(data: string): void; close(): void }
/** `data` is present only when the caller supplied an `errorData` schema and the reply matched it. */
export class RpcFailure extends Error {
  constructor(public readonly code: number | "unavailable", message: string, public readonly outcome?: "unknown", public readonly data?: unknown) { super(message); }
}
/** `signal` stops waiting: before sending the call is not sent; after, it rejects with outcome
 * "unknown" and a late reply is dropped. The remote is not told; callers cancel at the method level. */
export interface CallOptions { errorData?: z.ZodType; timeoutMs?: number; signal?: AbortSignal }

const request = z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), method: z.string(), params: z.unknown() });
const response = z.union([
  z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), error: z.strictObject({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) }),
]);
export interface RpcHandler { params: z.ZodType; result: z.ZodType; handle(params: unknown): Promise<unknown> }
/** Notifications have no id and are never answered. Unknown, invalid or failing ones are dropped and
 * logged rather than closing the link: they are best-effort, and closing would fail durable in-flight calls. */
export interface NotificationHandler { params: z.ZodType; notify(params: unknown): void | Promise<void> }
const notification = z.strictObject({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown() });
const dropped = (method: string, reason: string, error?: unknown) => console.warn(`Dropped JSON-RPC notification ${method.slice(0, 128)}: ${reason}`, ...(error === undefined ? [] : [error]));
/** Default for sockets that cross a process boundary; an in-process link passes Infinity. */
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
/** Local failure for an outbound frame over the cap: the message is never sent and retrying it cannot
 * succeed, so it is neither "unavailable" nor an unknown outcome, and the connection stays open. */
export const FRAME_TOO_LARGE = -32004;
/** Connection-level liveness notification; see `Heartbeat`. */
export const HEARTBEAT_METHOD = "node.ping";
/** Injectable for tests; defaults to the global timers. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), // eslint-disable-line typescript-eslint/consistent-type-assertions -- a handle this object created
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>), // eslint-disable-line typescript-eslint/consistent-type-assertions -- a handle this object created
};
/**
 * Transport-neutral liveness: every `intervalMs` each side sends a `node.ping` notification (no id, no
 * reply, no epoch, no session seq, never touches the outbox) and counts an interval in which it received
 * no frame at all as missed; any frame counts as heard, so a busy link needs no pings to stay up. After
 * `missedIntervals` consecutive missed intervals the peer is treated as dead and the connection closed
 * (in-flight calls fail with outcome unknown).
 */
export interface Heartbeat { intervalMs: number; missedIntervals: number }
export interface PeerOptions { maxFrameBytes?: number; heartbeat?: Heartbeat; timers?: Timers }
const MAX_IN_FLIGHT = 64;
export const MAX_ERROR_MESSAGE = 2048;
const MAX_ERROR_DATA_BYTES = 8192;
const MAX_EXPIRED = 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** A transport-neutral JSON-RPC 2.0 peer. Call receive from the WS message callback and close on WS close. */
export function createRpcPeer(socket: WireSocket, handlers: Record<string, RpcHandler | NotificationHandler>, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, heartbeat, timers = systemTimers }: PeerOptions = {}) {
  let closed = false;
  let heard = true;
  let missed = 0;
  let nextId = 0;
  let inbound = 0;
  const pending = new Map<string, { schema: z.ZodType; errorData?: z.ZodType; settle(): void; resolve(value: unknown): void; reject(reason: RpcFailure): void }>();
  // Timed-out IDs whose late reply is dropped rather than treated as a protocol violation.
  const expired = new Set<string>();
  const fail = () => {
    if (closed) return;
    closed = true;
    if (beat !== undefined) timers.clearInterval(beat);
    for (const call of pending.values()) { call.settle(); call.reject(new RpcFailure("unavailable", "Connection closed; outcome unknown", "unknown")); }
    pending.clear();
    socket.close();
  };
  const send = (value: unknown) => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > maxFrameBytes) throw new RpcFailure(FRAME_TOO_LARGE, `Frame exceeds ${maxFrameBytes} bytes`);
    socket.send(text);
  };
  const beat = heartbeat && timers.setInterval(() => {
    if (heard) missed = 0;
    else if (++missed >= heartbeat.missedIntervals) {
      console.warn(`JSON-RPC peer silent for ${missed} heartbeat intervals; closing the connection`);
      fail();
      return;
    }
    heard = false;
    try { send({ jsonrpc: "2.0", method: HEARTBEAT_METHOD, params: {} }); } catch { fail(); }
  }, heartbeat.intervalMs);
  return {
    close: fail,
    /** A timeout rejects with outcome "unknown": the remote may still handle the request. */
    async call<T>(method: string, params: unknown, schema: z.ZodType<T>, options: CallOptions = {}): Promise<T> {
      if (closed) throw new RpcFailure("unavailable", "Connection closed", "unknown");
      if (pending.size >= MAX_IN_FLIGHT) throw new RpcFailure("unavailable", "Too many in-flight calls");
      if (options.signal?.aborted) throw new RpcFailure("unavailable", "Call aborted before sending");
      const id = `rpc-${++nextId}`;
      return new Promise<T>((resolve, reject) => {
        const abandon = (message: string) => {
          if (!pending.delete(id)) return;
          settle();
          expired.add(id);
          if (expired.size > MAX_EXPIRED) expired.delete(expired.values().next().value!);
          reject(new RpcFailure("unavailable", `${message}; outcome unknown`, "unknown"));
        };
        const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => abandon(`Call timed out after ${options.timeoutMs}ms`), options.timeoutMs);
        const aborted = () => abandon("Call aborted");
        const settle = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); };
        options.signal?.addEventListener("abort", aborted, { once: true });
        pending.set(id, { schema, errorData: options.errorData, settle, resolve: value => resolve(schema.parse(value)), reject });
        try { send({ jsonrpc: "2.0", id, method, params }); }
        catch (error) {
          pending.delete(id);
          settle();
          // An oversized frame was never sent: only that call fails. A socket failure closes the peer.
          if (error instanceof RpcFailure) { reject(error); return; }
          reject(new RpcFailure("unavailable", "Send failed; outcome unknown", "unknown"));
          fail();
        }
      });
    },
    /** Best effort, no reply: false when closed or unsendable (e.g. over the frame cap). A socket error closes the peer. */
    notify(method: string, params: unknown): boolean {
      if (closed) return false;
      try { send({ jsonrpc: "2.0", method, params }); return true; }
      catch (error) { if (!(error instanceof RpcFailure)) fail(); return false; }
    },
    receive(data: string | Uint8Array): void {
      if (closed) return;
      heard = true;
      if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > maxFrameBytes) { fail(); return; }
      let value: unknown;
      try { value = JSON.parse(data); } catch { fail(); return; }
      const incoming = request.safeParse(value);
      if (incoming.success) {
        const { id, method, params } = incoming.data;
        const handler = handlers[method];
        if (!handler || "notify" in handler) { send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }); return; }
        const parsed = handler.params.safeParse(params);
        if (!parsed.success) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }); return; }
        if (inbound >= MAX_IN_FLIGHT) { send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Busy" } }); return; }
        inbound++;
        void Promise.resolve().then(() => handler.handle(parsed.data)).then(result => {
          const checked = handler.result.safeParse(result);
          if (!checked.success) throw new RpcFailure(-32603, "Invalid handler result");
          if (!closed) send({ jsonrpc: "2.0", id, result: checked.data });
        }).catch(error => {
          if (closed) return;
          const failure = error instanceof RpcFailure ? error : new RpcFailure(-32603, "Internal error");
          const code = typeof failure.code === "number" ? failure.code : -32603;
          const message = failure.message.slice(0, MAX_ERROR_MESSAGE);
          if (failure.data === undefined) send({ jsonrpc: "2.0", id, error: { code, message } });
          else if (bytes(failure.data) > MAX_ERROR_DATA_BYTES) send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
          else send({ jsonrpc: "2.0", id, error: { code, message, data: failure.data } });
        }).finally(() => { inbound--; });
        return;
      }
      const note = notification.safeParse(value);
      if (note.success) {
        const { method, params } = note.data;
        if (method === HEARTBEAT_METHOD) return; // liveness only: already counted as heard
        const handler = handlers[method];
        if (!handler || !("notify" in handler)) { dropped(method, "unknown method"); return; }
        const parsed = handler.params.safeParse(params);
        if (!parsed.success) { dropped(method, "invalid params"); return; }
        // Handlers start synchronously in arrival order.
        try { void Promise.resolve(handler.notify(parsed.data)).catch(error => dropped(method, "handler failed", error)); }
        catch (error) { dropped(method, "handler failed", error); }
        return;
      }
      const reply = response.safeParse(value);
      if (!reply.success) { fail(); return; }
      const call = pending.get(String(reply.data.id));
      if (!call) { if (!expired.delete(String(reply.data.id))) fail(); return; }
      pending.delete(String(reply.data.id));
      call.settle();
      if ("error" in reply.data) {
        const { code, message, data: detail } = reply.data.error;
        // Error data from an untrusted peer is bounded and typed by the caller, or dropped.
        const checked = detail === undefined || !call.errorData ? undefined : bytes(detail) > MAX_ERROR_DATA_BYTES ? null : call.errorData.safeParse(detail);
        if (message.length > MAX_ERROR_MESSAGE || checked === null || checked?.success === false) { call.reject(new RpcFailure(-32603, "Invalid error response")); fail(); return; }
        call.reject(new RpcFailure(code, message, undefined, checked?.data));
        return;
      }
      const result = call.schema.safeParse(reply.data.result);
      if (!result.success) { call.reject(new RpcFailure(-32603, "Invalid response")); fail(); return; }
      call.resolve(result.data);
    },
  };
}
