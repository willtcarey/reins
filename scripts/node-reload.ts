/**
 * `bun run node:reload [nodeId] [--force]`: asks the running Reins server (`REINS_PORT`, 3100 by default)
 * to restart a node on its new code, the local node (`internal`) by default. It exits once the reload is
 * scheduled: the node holds its runs at their next pause point, restarts when nothing is in flight and the
 * server resumes the runs (ADR-021). `--force` cuts off calls still in flight at the node's 60 s bound
 * instead of cancelling the reload. Same as `POST /api/nodes/:nodeId/reload`.
 */
import { ReinsClient, ReinsHttpError } from "@reins/client";

const args = process.argv.slice(2);
const force = args.includes("--force");
const nodeId = args.find(arg => !arg.startsWith("--")) ?? process.env.REINS_NODE_ID?.trim() ?? "internal";
const port = process.env.REINS_PORT?.trim() || "3100";
const client = new ReinsClient({ baseUrl: `http://localhost:${port}` });

try {
  await client.nodes.reload(nodeId, { force });
} catch (error) {
  if (error instanceof ReinsHttpError) console.error(`Node ${nodeId} did not reload (${error.status}): ${error.message}`);
  else console.error(`No Reins server on port ${port}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(`Node ${nodeId} reload scheduled: it restarts once its runs reach a pause point, and they continue on the new code.`);
