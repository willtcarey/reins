import { Type, type Static } from "@sinclair/typebox";
import type { AppState } from "../state.js";
import { RequestRefused } from "../errors.js";
import { createSession as insertSession, getSession, latestTaskSession, updateSessionMeta } from "../session-store.js";
import { getProject, touchProject } from "../project-store.js";
import { defaultSourceOf, resolveSource } from "../models/sources.js";
import { getTask, touchTask } from "../task-store.js";
import { createBroadcast, type Broadcast } from "../models/broadcast.js";
import { getDb } from "../app-globals.js";
import { getSource, type Source } from "../node-store.js";
import { parseThinkingLevel, piModelSetting, ThinkingLevelSchema } from "../models/model-settings.js";
import { DEFAULT_SESSION_KIND, sessionKind } from "./session-kinds.js";
import { Nodes } from "../models/nodes.js";

export interface SessionCreationOptions {
  /** Its project; left out, a session of no project, which must name where it works and has no task. */
  projectId?: number;
  taskId?: number;
  parentSessionId?: string;
  title?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** Where it works; else inherited (`createSession`). */
  sourceId?: number;
  /** A session the browser never shows: not listed, counted or badged (for Reins features, not scripts). */
  background?: boolean;
  /** How the session runs (`sessions/session-kinds.ts`; for Reins features, not scripts): a registered
   * kind, "agent" by default. */
  kind?: string;
  /** The backend extension starting it (`reins.sessions.start`). */
  sourceExtension?: string;
}

/** A session cannot be created as asked; its message says why, to whoever asked (HTTP: 400). */
export class SessionCreationRefused extends RequestRefused {
  constructor(message: string) {
    super(message);
    this.name = "SessionCreationRefused";
  }
}

/** Where a requested session works, as clients name it: a node and an absolute path on it (a directory not
 * known yet is checked on its node, `ensureSource`). The HTTP request bodies use it. */
export const SessionLocationSchema = Type.Object({ nodeId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) });

/** The model a requested session runs, and optionally its thinking level. The HTTP request bodies use it. */
export const SessionModelChoiceSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

/** A session as a client asks for one (`Sessions.create`): where it works as a source or a location, and
 * its model with its thinking level (left out, the `default_model` setting's). */
export interface SessionRequest extends Omit<SessionCreationOptions, "sourceId" | "model" | "thinkingLevel"> {
  /** A source's ID, or a location (`SessionLocationSchema`); left out, inherited as `createSession` places it. */
  source?: number | Static<typeof SessionLocationSchema>;
  model?: { provider: string; modelId: string; thinkingLevel?: string };
}

/** The project must exist, a task be one of its own, and a session of no project name where it works
 * (`placed`: a source, or a parent to inherit it from). */
export function assertPlace(projectId: number | null, taskId: number | undefined, placed: boolean): void {
  if (projectId !== null && !getProject(projectId)) throw new SessionCreationRefused(`Project not found: ${projectId}`);
  if (projectId === null && !placed) throw new SessionCreationRefused("A session of no project needs a source");
  if (taskId === undefined) return;
  if (projectId === null) throw new SessionCreationRefused("A session of no project has no task");
  const task = getTask(taskId);
  if (!task) throw new SessionCreationRefused(`Task not found: ${taskId}`);
  if (task.project_id !== projectId) throw new SessionCreationRefused(`Task ${taskId} is not a task of project ${projectId}`);
}

/**
 * Creates a session's row, of project `opts.projectId` or of none, and announces it (`session_created`,
 * on the caller's `broadcast`) unless it is a background session. Clients' requests come through
 * `Sessions.create`, which checks them first; this is the step that keeps the row, for that and for the
 * server's own sessions (a task generator's utility session). It works in `opts.sourceId`, else inherits a source: its parent's,
 * else its task's most recently active session's, else its project's default source. A session of no project needs
 * a source (it has nothing to inherit from), and has no task; a task must be of the session's project.
 * Placement is server policy, not a live connectivity check: a session whose node is not connected is
 * created, and its runs wait for the node to prepare the checkout and run tools. Nothing here opens a
 * runtime: Pi's lane is created when the session's runtime first opens (`session-runtime/live.ts`).
 * Without a model of its own the session gets the `default_model` setting's (throws when that setting is
 * of another runtime). An unknown kind throws.
 */
export function createSession(state: AppState, opts: SessionCreationOptions, broadcast: Broadcast = createBroadcast(state.process)): { id: string } {
  const projectId = opts.projectId ?? null;
  assertPlace(projectId, opts.taskId, opts.sourceId !== undefined || opts.parentSessionId !== undefined);
  const kind = opts.kind ?? DEFAULT_SESSION_KIND;
  sessionKind(kind);

  const source = placement(projectId, opts);
  const sessionId = crypto.randomUUID();

  const defaultModel = opts.model && opts.thinkingLevel ? undefined : piModelSetting("default_model");
  const model = opts.model ?? (defaultModel && { provider: defaultModel.provider, modelId: defaultModel.modelId });
  const thinkingLevel = opts.thinkingLevel ? parseThinkingLevel(opts.thinkingLevel) : defaultModel?.thinkingLevel ?? null;

  // Frozen here: the row carries the resolved model/thinking level, from which Pi's main lane is seeded
  // when the session's runtime first opens; a later default_model edit does not reach existing sessions.
  // The task is read from its row whenever the runtime opens.
  const nodes = new Nodes(state, broadcast);
  const sources = nodes.watchSources();
  getDb().transaction(() => {
    insertSession(sessionId, projectId, {
      modelProvider: model?.provider,
      modelId: model?.modelId,
      thinkingLevel: thinkingLevel ?? "off",
      agentRuntimeType: "pi",
      taskId: opts.taskId,
      parentSessionId: opts.parentSessionId,
      sourceId: source.id,
      background: opts.background,
      kind,
      sourceExtension: opts.sourceExtension,
    });
    if (opts.title !== undefined) updateSessionMeta(sessionId, { name: opts.title });
  })();
  sources.publishChanged();

  // A background session does not move its task or project up their lists, and is not announced: the
  // browser would list it before learning it is one.
  if (opts.background) return { id: sessionId };
  if (opts.taskId) touchTask(opts.taskId);
  if (projectId !== null) touchProject(projectId);

  broadcast({
    type: "session_created",
    projectId,
    sessionId,
    taskId: opts.taskId ?? null,
    parentSessionId: opts.parentSessionId ?? null,
  });

  return { id: sessionId };
}

/** Where a new session works: the source it names (`SessionCreationRefused` when there is none), else its
 * parent's, else `inheritedSource` (`SourceNotFoundError` when the project has no default source). */
function placement(projectId: number | null, opts: SessionCreationOptions): Source {
  if (opts.sourceId !== undefined) {
    const source = getSource(opts.sourceId);
    if (!source) throw new SessionCreationRefused(`Source not found: ${opts.sourceId}`);
    return source;
  }
  const parent = opts.parentSessionId === undefined ? null : getSession(opts.parentSessionId);
  if (parent) return resolveSource(parent.source_id);
  if (projectId === null) throw new SessionCreationRefused("A session of no project needs a source");
  return inheritedSource(projectId, opts.taskId);
}

/** Where a new session of the project (and task) works when nothing names a place: its task's most recently
 * active session's location, else the project's default source (`SourceNotFoundError` without one). */
export function inheritedSource(projectId: number, taskId?: number): Source {
  const recent = taskId === undefined ? null : latestTaskSession(taskId);
  return recent ? resolveSource(recent.source_id) : defaultSourceOf(projectId);
}
