/**
 * One session as its runtime opens it (`SessionModel`, from `Sessions.get`): where it runs and what its
 * runtime is opened with (`SessionContext`).
 */
import type { SessionRow } from "../session-store.js";
import { getNode, type Source } from "../node-store.js";
import { getTask } from "../task-store.js";
import { sessionKind, type SessionKindConfig } from "../sessions/session-kinds.js";
import { piModelSetting } from "./model-settings.js";
import { sessionSource } from "./sources.js";

/** Where a session runs (its source and the checkout's path) and the identity Pi's session is created with. */
export interface SessionBinding { sourceId: number; cwd: string; createdAt: string; parentSessionId: string | null }
/** The model and thinking level (null: off) Pi's main lane starts with when the session has none yet
 * (null model: none resolved, so the session cannot run until its model is set). Once the lane exists,
 * Pi's own lane state is the selection. */
export interface LaneSeed { model: { provider: string; modelId: string } | null; thinkingLevel: string | null }

/** What a session's runtime is opened with: the binding, the lane seed, and what the session's kind
 * resolves, the runtime configuration (with the system prompt) and the branch checked out first (null:
 * none). */
export interface SessionContext { binding: SessionBinding; branch: string | null; lane: LaneSeed; runtime: SessionKindConfig }

/** The session's node was removed: no node runs its work until it is moved to another (`Sessions.move`). */
export class SessionNodeRemovedError extends Error {
  constructor() {
    super("This session's node was removed; move it to another node to continue");
    this.name = "SessionNodeRemovedError";
  }
}

/** One session, as its row was when it was read. */
export class SessionModel {
  constructor(readonly row: SessionRow) {}

  get id(): string { return this.row.id; }
  get projectId(): number { return this.row.project_id; }

  /** Where the session runs: its source, or null when that is gone. */
  source(): Source | null {
    return sessionSource(this.row);
  }

  /** Throws `SessionNodeRemovedError` when the node of `source` (the session's) was removed: the session
   * stays readable and movable, but no work for it is accepted there. */
  assertRunnable(source: Source): void {
    if (getNode(source.node_id)?.removedAt) throw new SessionNodeRemovedError();
  }

  /** Where the session runs in `source` (its checkout) and the identity Pi's session is created with. */
  binding(source: Source): SessionBinding {
    return { sourceId: source.id, cwd: source.path, createdAt: this.row.created_at, parentSessionId: this.row.parent_session_id };
  }

  /** The session's context (`SessionContext`) in `source`, built from the rows now, so task and prompt edits
   * reach the runtime the next time it opens; throws when the lane seed cannot be built (an
   * unusable `default_model`) or the session's kind is unknown. */
  context(source: Source): SessionContext {
    const task = this.row.task_id === null ? null : getTask(this.row.task_id);
    const { branch = null, ...runtime } = sessionKind(this.row.kind)({ session: this.row, task });
    return { binding: this.binding(source), branch, lane: laneSeed(this.row), runtime };
  }
}

/** A stored thinking level as a lane seed carries it: `off` is null. */
const thinking = (level: string | null) => level && level !== "off" ? level : null;

/** The model Pi's main lane starts with if the session has none yet (seeded when its runtime opens): the
 * row's, else the current `default_model` setting's (with its thinking level); a null model when neither
 * resolves. Validated against the catalog when the runtime opens. */
function laneSeed(row: SessionRow): LaneSeed {
  if (row.model_provider && row.model_id) return { model: { provider: row.model_provider, modelId: row.model_id }, thinkingLevel: thinking(row.thinking_level) };
  const defaultModel = piModelSetting("default_model");
  if (!defaultModel) return { model: null, thinkingLevel: null };
  return { model: { provider: defaultModel.provider, modelId: defaultModel.modelId }, thinkingLevel: thinking(defaultModel.thinkingLevel) };
}
