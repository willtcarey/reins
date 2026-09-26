import { z } from "zod";

export interface WireSocket { send(data: string): void; close(): void }
export class RpcFailure extends Error {
  constructor(public readonly code: number | "unavailable", message: string, public readonly outcome?: "unknown") { super(message); }
}

const request = z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), method: z.string(), params: z.unknown() });
const response = z.union([
  z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]), error: z.strictObject({ code: z.number().int(), message: z.string() }) }),
]);
export interface RpcHandler { params: z.ZodType; result: z.ZodType; handle(params: unknown): Promise<unknown> }
const MAX_BYTES = 1_048_576;
const MAX_IN_FLIGHT = 64;

/** A transport-neutral JSON-RPC 2.0 peer. Call receive from the WS message callback and close on WS close. */
export function createRpcPeer(socket: WireSocket, handlers: Record<string, RpcHandler>) {
  let closed = false;
  let nextId = 0;
  let inbound = 0;
  const pending = new Map<string, { schema: z.ZodType; resolve(value: unknown): void; reject(reason: RpcFailure): void }>();
  const fail = () => {
    if (closed) return;
    closed = true;
    for (const call of pending.values()) call.reject(new RpcFailure("unavailable", "Connection closed; outcome unknown", "unknown"));
    pending.clear();
    socket.close();
  };
  const send = (value: unknown) => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new RpcFailure("unavailable", "Frame exceeds 1 MiB");
    socket.send(text);
  };
  return {
    close: fail,
    async call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
      if (closed) throw new RpcFailure("unavailable", "Connection closed", "unknown");
      if (pending.size >= MAX_IN_FLIGHT) throw new RpcFailure("unavailable", "Too many in-flight calls");
      const id = `rpc-${++nextId}`;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { schema, resolve: value => resolve(schema.parse(value)), reject });
        try { send({ jsonrpc: "2.0", id, method, params }); }
        catch (error) {
          pending.delete(id);
          reject(error instanceof RpcFailure ? error : new RpcFailure("unavailable", "Send failed; outcome unknown", "unknown"));
          fail();
        }
      });
    },
    receive(data: string | Uint8Array): void {
      if (closed) return;
      if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_BYTES) { fail(); return; }
      let value: unknown;
      try { value = JSON.parse(data); } catch { fail(); return; }
      const incoming = request.safeParse(value);
      if (incoming.success) {
        const { id, method, params } = incoming.data;
        const handler = handlers[method];
        if (!handler) { send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }); return; }
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
          send({ jsonrpc: "2.0", id, error: { code: typeof failure.code === "number" ? failure.code : -32603, message: failure.message } });
        }).finally(() => { inbound--; });
        return;
      }
      const reply = response.safeParse(value);
      if (!reply.success) { fail(); return; }
      const call = pending.get(String(reply.data.id));
      if (!call) { fail(); return; }
      pending.delete(String(reply.data.id));
      if ("error" in reply.data) { call.reject(new RpcFailure(reply.data.error.code, reply.data.error.message)); return; }
      const result = call.schema.safeParse(reply.data.result);
      if (!result.success) { call.reject(new RpcFailure(-32603, "Invalid response")); fail(); return; }
      call.resolve(result.data);
    },
  };
}
