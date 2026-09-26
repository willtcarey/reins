import { APPLICATION_ERROR, nodeError, RpcFailure } from "@reins/node/protocol";
import type { NodeResult } from "@reins/node/contract";
import { DeliveryDeferred } from "../models/node-command-transport.js";

// Busy/stale-epoch rejections happen before the handler runs; lost connections and timeouts leave
// the outcome unknown. Replay is safe only because node provision admission is receipted by command ID.
const DEFERRED = new Set<RpcFailure["code"]>(["unavailable", -32002, -32003]);

/** Maps a provision call to the node's NodeResult; throws DeliveryDeferred to requeue, or rethrows
 * protocol failures (e.g. invalid params) as terminal delivery exceptions. */
export async function provisionOutcome(call: () => Promise<unknown>): Promise<NodeResult> {
  try {
    await call();
    return { ok: true, value: { kind: "provisioned" } };
  } catch (error) {
    if (!(error instanceof RpcFailure)) throw error;
    if (error.outcome === "unknown" || DEFERRED.has(error.code)) throw new DeliveryDeferred(error.message);
    const rejected = error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data) : undefined;
    if (rejected?.success) return { ok: false, error: rejected.data };
    throw error;
  }
}
