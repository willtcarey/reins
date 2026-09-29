import type { Database } from "bun:sqlite";
import { PiStorageAdapter } from "@reins/pi-sql-storage";
import { createMainLane, storedLaneModel } from "@reins/pi-sql-storage/lane";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { SessionRow } from "../../session-store.js";
import { getSetting } from "../../settings-store.js";
import { getSource } from "../../node-store.js";
import { createPiModelRuntime } from "./factory.js";
import { ModelNotFoundError } from "./model-catalog.js";

/**
 * Creates the session's main Pi lane in `db` (the server's database) unless it exists, with the server's
 * Pi model context. The model is the row's, else the `default_model` setting's (with its thinking
 * level), as session creation resolves it. Returns whether the session has a lane: false when no model
 * resolves (nothing is written, as provisioning a node session writes no lane). A model the server's
 * catalog does not know throws `ModelNotFoundError` before anything is written.
 */
export async function ensureMainLane(db: Database, sessionId: string): Promise<boolean> {
  const row = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const storage = new PiStorageAdapter(db, sessionId);
  try {
    if (await storedLaneModel(storage)) return true;
    const selected = laneSelection(row);
    if (!selected) return false;
    const models = await createPiModelRuntime();
    const model = models.getModel(selected.provider, selected.modelId);
    if (!model) throw new ModelNotFoundError(selected.provider, selected.modelId);
    const source = getSource(row.source_id);
    if (!source) throw new Error(`Execution source unavailable for session ${sessionId}`);
    await createMainLane(storage, {
      sessionId, createdAt: row.created_at, cwd: source.path, parentSessionId: row.parent_session_id,
      models, model, thinkingLevel: selected.thinkingLevel,
    });
    return true;
  } finally { await storage.close(BACKGROUND_CONTEXT); }
}

function laneSelection(row: SessionRow): { provider: string; modelId: string; thinkingLevel: string } | null {
  if (row.model_provider && row.model_id) return { provider: row.model_provider, modelId: row.model_id, thinkingLevel: row.thinking_level };
  const defaultModel = getSetting("default_model");
  if (!defaultModel) return null;
  if (defaultModel.runtimeType !== "pi") {
    throw new Error(`Configured default_model uses unavailable runtime '${defaultModel.runtimeType}'. Update it in Settings.`);
  }
  return { provider: defaultModel.provider, modelId: defaultModel.modelId, thinkingLevel: defaultModel.thinkingLevel };
}
