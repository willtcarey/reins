import { startNode, type Node } from "@reins/node/node";
import type { NodeSessionBinding } from "@reins/node/storage";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import type { ServerState } from "../state.js";
import { applyNodeReplica, getNodeDb } from "./pi/node-storage.js";
import { SessionManager } from "./session-manager.js";
import { createCustomTools } from "../tools/index.js";
import { createBroadcast } from "../models/broadcast.js";
import { externalizeRuntimeEventImages } from "./runtime-image-externalization.js";
import { buildReinsSystemPrompt } from "./system-prompt.js";
import { createDbCredentialStore } from "./pi/credential-store.js";
import { getSessionAttachment } from "../session-attachments-store.js";
import { getSetting } from "../settings-store.js";
import { parseThinkingLevel } from "../models/model-settings.js";
import { getTask } from "../task-store.js";
import { checkoutBranch, getCurrentBranch } from "../git.js";
import { logger } from "../logger.js";

/** Product identity/path/config resolution stays server-side. No server DB handle reaches node code. */
export function provisionForSession(sessionId: string): { binding: NodeSessionBinding; storageOwner: string } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id || source.node_id !== "internal") {
    throw new Error(`Execution source unavailable for session ${sessionId}`);
  }
  return {
    storageOwner: row.storage_owner,
    binding: { sourceId: source.id, cwd: source.path, createdAt: row.created_at, parentSessionId: row.parent_session_id },
  };
}

const nodes = new WeakMap<ServerState, Node>();
export function installedInternalNode(state: ServerState): Node | undefined { return nodes.get(state); }
export function internalNodeFor(state: ServerState): Node {
  let node = nodes.get(state);
  if (!node) {
    node = startNode({
      db: getNodeDb(),
      deliver: (id, seq, json) => applyNodeReplica(getDb(), id, seq, json),
      fetchAttachment: async (id, attachmentId) => {
        if (provisionForSession(id).storageOwner !== "internal-node") throw new Error(`Node session unavailable: ${id}`);
        const row = getSessionAttachment(id, attachmentId);
        return row?.data ? { data: row.data, mimeType: row.mime_type, byteSize: row.byte_size,
          sha256: row.sha256, filename: row.filename ?? undefined,
          width: row.width ?? undefined, height: row.height ?? undefined } : null;
      },
      // The server supplies product policy and attachment bytes; the node builds and holds Pi.
      prepare: async (id, binding) => {
        const current = provisionForSession(id);
        if (current.storageOwner !== "internal-node" || JSON.stringify(current.binding) !== JSON.stringify(binding)) {
          throw new Error(`Node session binding mismatch: ${id}`);
        }
        const row = getSession(id)!;
        const defaultModel = getSetting("default_model");
        const model = row.model_provider && row.model_id
          ? { provider: row.model_provider, modelId: row.model_id }
          : defaultModel?.runtimeType === row.agent_runtime_type
            ? { provider: defaultModel.provider, modelId: defaultModel.modelId }
            : null;
        const thinkingLevel = row.thinking_level === "off" ? null : row.thinking_level
          ? parseThinkingLevel(row.thinking_level)
          : defaultModel?.runtimeType === row.agent_runtime_type ? defaultModel.thinkingLevel : null;
        const task = row.task_id ? getTask(row.task_id) : null;
        if (row.task_id && !task) throw new Error(`Task not found: ${row.task_id}`);
        if (task && await getCurrentBranch(binding.cwd) !== task.branch_name) await checkoutBranch(binding.cwd, task.branch_name);
        const manager = new SessionManager(state);
        const instance = manager.forSession(id);
        const broadcast = createBroadcast(state.clients);
        return {
          model, thinkingLevel, credentials: createDbCredentialStore(),
          customTools: createCustomTools({ projectId: row.project_id, sessionId: id, taskId: row.task_id,
            broadcast, sessions: state.sessions, instance }),
          systemPrompt: (tools, contextFiles, skills) => buildReinsSystemPrompt({
            tools, contextFiles, skills, task: task ?? undefined, isScratchSession: !task,
          }),
          lifecycle: instance,
          observe: event => broadcast({ type: "event", sessionId: id, projectId: row.project_id,
            event: externalizeRuntimeEventImages(id, event) }),
          onError: (message, error) => logger.error(message, error),
        };
      },
    });
    nodes.set(state, node);
  }
  return node;
}
export function stopInternalNode(state: ServerState): void {
  nodes.get(state)?.stop();
  nodes.delete(state);
}
