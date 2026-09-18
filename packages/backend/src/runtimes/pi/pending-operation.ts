import type { Database } from "bun:sqlite";

export interface PendingPiOperation {
  kind: "run" | "compaction" | "navigation";
}

interface ValueRow {
  value_json: string;
}

/** Read the durable main-lane operation without opening an LLM runtime. */
export function readPendingPiOperation(db: Database, sessionId: string): PendingPiOperation | null {
  const laneRow = db.query<ValueRow, [string, string, string]>(
    "SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?",
  ).get(sessionId, "pi.lane.state", "main");
  if (!laneRow) return null;

  const laneState: unknown = JSON.parse(laneRow.value_json);
  if (typeof laneState !== "object" || laneState === null || !("currentOperationId" in laneState)) return null;
  const operationId = laneState.currentOperationId;
  if (typeof operationId !== "string" || operationId.length === 0) return null;

  const operationRow = db.query<ValueRow, [string, string, string]>(
    "SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?",
  ).get(sessionId, "pi.op.meta", operationId);
  if (!operationRow) return null;

  const operation: unknown = JSON.parse(operationRow.value_json);
  if (typeof operation !== "object" || operation === null || !("intent" in operation)) return null;
  const intent = operation.intent;
  if (typeof intent !== "object" || intent === null || !("kind" in intent)) return null;
  return intent.kind === "run" || intent.kind === "compaction" || intent.kind === "navigation"
    ? { kind: intent.kind }
    : null;
}
