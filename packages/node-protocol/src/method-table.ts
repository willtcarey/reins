import { z } from "zod";
import type { createRpcPeer, NotificationHandler, RpcHandler, RpcHandlers } from "./rpc.js";

/** One wire method as both ends see it. `params` never includes the connection's `epoch`: every frame
 * carries one, which `serveMethods` checks and strips and `methodClient` adds. A request has a `result`,
 * optionally the schema its rejection data must match (`errorData`) and a default call bound
 * (`timeoutMs`); a method without `result` is a notification, never answered. */
export interface RequestSpec { params: z.ZodType<object>; result: z.ZodType; errorData?: z.ZodType; timeoutMs?: number }
export interface NotificationSpec { params: z.ZodType<object>; result?: undefined }
/** Wire method name → spec: one table per direction (`nodeMethods`, `serverMethods` in `schema.ts`). */
export type MethodTable = Record<string, RequestSpec | NotificationSpec>;
export type MethodInput<Spec extends RequestSpec | NotificationSpec> = z.output<Spec["params"]>;
export type MethodResult<Spec extends RequestSpec | NotificationSpec> = Spec extends RequestSpec ? z.output<Spec["result"]> : never;
export type RequestMethod<Table extends MethodTable> = { [M in keyof Table & string]: Table[M] extends RequestSpec ? M : never }[keyof Table & string];
export type NotificationMethod<Table extends MethodTable> = Exclude<keyof Table & string, RequestMethod<Table>>;
/** Serves each method of a table: a request answers with its result, a notification returns nothing.
 * `context` is what the serving side's `authorize` returned for the frame's epoch. */
export type MethodHandlers<Table extends MethodTable, Context> = {
  [M in keyof Table & string]: (input: MethodInput<Table[M]>, context: Context) => Table[M] extends RequestSpec
    ? MethodResult<Table[M]> | Promise<MethodResult<Table[M]>> : void | Promise<void>;
};
export interface MethodCallOptions { signal?: AbortSignal; timeoutMs?: number }

/** A table's method names. */
export const methodNames = <Table extends MethodTable>(table: Table) => Object.keys(table) as Array<keyof Table & string>; // eslint-disable-line typescript-eslint/consistent-type-assertions -- a table's own keys
/** `scope.name` → `scopeName`, the key `methods` lists a wire name under. */
type MethodKey<M extends string> = M extends `${infer Scope}.${infer Name}` ? `${Scope}${Capitalize<Name>}` : M;
export const methodKeys = <Table extends MethodTable>(table: Table) =>
  Object.fromEntries(methodNames(table).map(name => [name.replace(/\.(.)/, (_, first: string) => first.toUpperCase()), name])) as { [M in keyof Table & string as MethodKey<M>]: M }; // eslint-disable-line typescript-eslint/consistent-type-assertions -- keys derived from the names just listed

const epochParam = z.string().uuid();
/** The params as they cross the wire: the method's own params plus the connection's `epoch`, parsed
 * once into both (strict params still reject any field besides the epoch). */
function withEpoch<Input>(params: z.ZodType<Input>) {
  return z.looseObject({ epoch: epochParam }).transform(({ epoch, ...rest }, ctx) => {
    const input = params.safeParse(rest);
    if (input.success) return { epoch, input: input.data };
    ctx.issues.push({ code: "custom", message: "Invalid params", input: rest });
    return z.NEVER;
  });
}

/** The peer registry serving `table` with `handlers`. `authorize` checks each frame's epoch before its
 * handler runs (throwing refuses it) and returns what the handler runs with; it is called per frame, so
 * it may resolve handlers anew each time. A notification's handler starts synchronously when `authorize`
 * does not return a promise. `failure` maps a request handler's exception to the rejection sent. */
export function serveMethods<Table extends MethodTable, Context>(
  table: Table, handlers: NoInfer<MethodHandlers<Table, Context>>,
  authorize: (epoch: string, method: keyof Table & string) => Context | Promise<Context>,
  failure: (error: unknown) => unknown = error => error,
): RpcHandlers {
  const serve = <M extends keyof Table & string>(method: M): RpcHandler<{ epoch: string; input: MethodInput<Table[M]> }> | NotificationHandler<{ epoch: string; input: MethodInput<Table[M]> }> => {
    const spec = table[method];
    const params = withEpoch(spec.params as z.ZodType<MethodInput<Table[M]>>); // eslint-disable-line typescript-eslint/consistent-type-assertions -- a generic index loses the table's pairing of params and handler
    const handle: (input: MethodInput<Table[M]>, context: Context) => unknown = handlers[method];
    if (!spec.result) return {
      params,
      notify({ epoch: current, input }) {
        const context = authorize(current, method);
        return context instanceof Promise ? context.then(value => handle(input, value)) : handle(input, context);
      },
    };
    return {
      params, result: spec.result,
      async handle({ epoch: current, input }) {
        const context = await authorize(current, method);
        try { return await handle(input, context); } catch (error) { throw failure(error); }
      },
    };
  };
  return Object.fromEntries(methodNames(table).map(method => [method, serve(method)]));
}

/** Calls a table's methods on `peer`: adds `epoch`, checks the result (and rejection data) against the
 * table and bounds the call by the table's timeout unless `timeoutMs` is given. */
export function methodClient<Table extends MethodTable>(peer: Pick<ReturnType<typeof createRpcPeer>, "call" | "notify">, table: Table) {
  return {
    call<M extends RequestMethod<Table>>(method: M, epoch: string, input: MethodInput<Table[M]>, { signal, timeoutMs }: MethodCallOptions = {}): Promise<MethodResult<Table[M]>> {
      const spec = table[method] as RequestSpec & { result: z.ZodType<MethodResult<Table[M]>> }; // eslint-disable-line typescript-eslint/consistent-type-assertions -- `RequestMethod` names only methods with a result, typed by the table
      return peer.call(method, { ...input, epoch }, spec.result, { errorData: spec.errorData, timeoutMs: timeoutMs ?? spec.timeoutMs, signal });
    },
    /** Best effort: false when the frame could not be sent. */
    notify<M extends NotificationMethod<Table>>(method: M, epoch: string, input: MethodInput<Table[M]>): boolean {
      return peer.notify(method, { ...input, epoch });
    },
  };
}
