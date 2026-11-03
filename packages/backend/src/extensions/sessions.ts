/**
 * The server SDK's `reins.sessions` for one extension (docs/dev/server-sdk.md *Sessions*): an adapter over
 * the `Sessions` model (`create`, `get`, `submit`, `compact`, `getContext`), as scripting's `api.sessions` is, with no
 * calling session: the extension names where a session works. What it starts and sends record it as their
 * origin (`sessions.source_extension`, the inputs' `metadata.sourceExtension`). Settlement listeners are the
 * host's (`ExtensionHost.sessionSettled`).
 */

import type { SessionInfo, Sessions } from "@reins/sdk/server";
import type { AppState } from "../state.js";
import { Models } from "../models/models.js";
import { sessionActivity } from "../models/session-activity.js";
import type { SessionModel } from "../models/session.js";

/** What an extension's `reins.sessions` does, but for its settlement listeners. */
export type ExtensionSessionAccess = Omit<Sessions, "onSettled">;

const text = (value: string) => [{ type: "text" as const, text: value }];

function sessionInfo(session: SessionModel, state: AppState): SessionInfo {
  const { row } = session;
  const source = session.source.record;
  return {
    id: row.id,
    source: { id: source.id, nodeId: source.node_id, path: source.path },
    projectId: row.project_id,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    background: row.background === 1,
    running: sessionActivity(row, state.process.sessions) === "running",
    startedBy: row.source_extension,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `reins.sessions` of extension `extension`, on the app's state. */
export function extensionSessions(state: AppState, extension: string): ExtensionSessionAccess {
  const models = () => new Models(state);
  return {
    async get(sessionId) {
      return sessionInfo(models().sessions.get(sessionId), state);
    },

    // A refused first prompt leaves the session: the extension sends it again, or moves the session.
    async start({ source, projectId, taskId, prompt, model, background, title }) {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A session's prompt must not be blank");
      const sessions = models().sessions;
      const { id } = await sessions.create({
        ...(projectId === undefined ? {} : { projectId }),
        ...(source === undefined ? {} : { source }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(title === undefined ? {} : { title }),
        ...(model ? { model } : {}),
        background: background === true,
        sourceExtension: extension,
      });
      await sessions.submit(id, { op: "prompt", content: text(prompt), clientId: crypto.randomUUID(), sourceExtension: extension });
      return id;
    },

    async send(sessionId, message) {
      if (typeof message !== "string" || !message.trim()) throw new Error("A message must not be blank");
      await models().sessions.submit(sessionId, { op: "steer", content: text(message), clientId: crypto.randomUUID(), sourceExtension: extension });
    },

    async compact(sessionId, options = {}) {
      await models().sessions.compact(sessionId, options.instructions === undefined ? {} : { instructions: options.instructions });
    },

    async contextUsage(sessionId) {
      const sessions = models().sessions;
      sessions.get(sessionId);
      const snapshot = await sessions.getContext(sessionId);
      return snapshot && { usedTokens: snapshot.usedTokens, contextWindow: snapshot.contextWindow, measurement: snapshot.measurement };
    },
  };
}
