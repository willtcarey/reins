import type { LaneSeed, NodeSessionBinding, SessionTask } from "@reins/node-protocol";
import { defaultSource, getSource, type Source } from "../node-store.js";
import { getSession, type SessionRow } from "../session-store.js";
import { getTask } from "../task-store.js";
import { piModelSetting } from "../models/model-settings.js";

/** A session's execution source and the node it belongs to. */
export interface SessionSource { source: Source; nodeId: string }

/** The session's source (or `sourceId`, another source of its project), or null when it is gone or
 * belongs to another project. Where the session's commands go: to that source's node. */
export function resolveSessionSource(row: Pick<SessionRow, "source_id" | "project_id">, sourceId = row.source_id): SessionSource | null {
  const source = getSource(sourceId);
  return source && source.project_id === row.project_id ? { source, nodeId: source.node_id } : null;
}

/** `resolveSessionSource`, throwing when the source is unavailable. */
export function requireSessionSource(sessionId: string, sourceId?: number): SessionSource & { row: SessionRow } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const resolved = resolveSessionSource(row, sourceId);
  if (!resolved) throw new Error(`Execution source unavailable for session ${sessionId}`);
  return { ...resolved, row };
}

/** What the session's commands carry to its node: the node binding for its source and what an opening
 * command carries (the task snapshot, read from the task row now so task edits reach the node the next
 * time it opens the runtime, null for a scratch session; and the lane seed). Built from the rows at send
 * time; throws when the lane seed cannot be (an unusable `default_model`). Product identity and path
 * resolution stay server-side; no server DB handle reaches node code. */
export interface CommandTarget { binding: NodeSessionBinding; task: SessionTask; lane: LaneSeed }
export function commandTarget(row: SessionRow, source: Source): CommandTarget {
  const task = row.task_id === null ? null : getTask(row.task_id);
  return {
    binding: { sourceId: source.id, cwd: source.path, createdAt: row.created_at, parentSessionId: row.parent_session_id },
    task: task ? { title: task.title, description: task.description, branchName: task.branch_name } : null,
    lane: laneSeed(row),
  };
}

/** `commandTarget` of the session's current source, and that source's node. */
export function sessionTarget(sessionId: string): CommandTarget & { nodeId: string } {
  const { row, source, nodeId } = requireSessionSource(sessionId);
  return { ...commandTarget(row, source), nodeId };
}

/** A stored thinking level as the wire carries it: `off` is null. */
const thinking = (level: string | null) => level && level !== "off" ? level : null;

/** The model Pi's main lane starts with if the session has none yet (the node seeds it when it opens the
 * runtime): the row's, else the current `default_model` setting's (with its thinking level); a null model
 * when neither resolves. The server does not validate it: the node's model registry does. */
function laneSeed(row: SessionRow): LaneSeed {
  if (row.model_provider && row.model_id) return { model: { provider: row.model_provider, modelId: row.model_id }, thinkingLevel: thinking(row.thinking_level) };
  const defaultModel = piModelSetting("default_model");
  if (!defaultModel) return { model: null, thinkingLevel: null };
  return { model: { provider: defaultModel.provider, modelId: defaultModel.modelId }, thinkingLevel: thinking(defaultModel.thinkingLevel) };
}

/** Where a new session is placed: the named source, else the project's default source (`defaultSource`).
 * Selection is server policy, not a live connectivity check: a session whose node is not connected is
 * created and its work waits in the outbox until the node connects. */
export function selectCreationSource(projectId: number, sourceId?: number): Source {
  const source = sourceId === undefined ? defaultSource(projectId) : getSource(sourceId);
  if (!source || source.project_id !== projectId) throw new Error(`Execution source unavailable for project ${projectId}`);
  return source;
}
