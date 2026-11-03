/**
 * One session (`SessionModel`, from `Sessions.get`, or the runtime opener's): where it works (its source on
 * its node, the base branch its diffs compare with) and what its runtime is opened with (`SessionContext`).
 */
import type { PromptContext } from "@reins/sdk/server";
import type { SessionRow } from "../session-store.js";
import { getNode, type Source } from "../node-store.js";
import type { NodeHub } from "../state.js";
import { getProject } from "../project-store.js";
import { getTask, updateTask, type TaskRow } from "../task-store.js";
import { sessionKind, type SessionKindConfig } from "../sessions/session-kinds.js";
import { piModelSetting } from "./model-settings.js";
import { resolveSource, SourceModel } from "./sources.js";
import type { Workspace } from "./workspace.js";

/** A session of no project has no base branch: its diffs compare with HEAD, so they show uncommitted work. */
const NO_BASE_BRANCH = "HEAD";

/** Where a session runs (its source and the checkout's path) and the identity Pi's session is created with. */
export interface SessionBinding { sourceId: number; cwd: string; createdAt: string; parentSessionId: string | null }
/** The model and thinking level (null: off) Pi's main lane starts with when the session has none yet
 * (null model: none resolved, so the session cannot run until its model is set). Once the lane exists,
 * Pi's own lane state is the selection. */
export interface LaneSeed { model: { provider: string; modelId: string } | null; thinkingLevel: string | null }

/**
 * The branch a run works on, checked out first: its task's. A checkout that does not have it gets it
 * (`Git.ensureBranch`: origin's, else new from `base`, the project's base branch), so a task's branch is
 * made where its sessions work, not where it was created. `recordBaseCommit` keeps where it begins (its
 * merge base with `base`) on the task, when it was made here or the task does not know it yet.
 */
export interface TaskBranch { name: string; base: string; baseCommitKnown: boolean; recordBaseCommit(commit: string): void }

/** What a session's runtime is opened with: the binding, the lane seed, and what the session's kind
 * resolves, the runtime configuration (with the system prompt) and the branch checked out first (null:
 * none). */
export interface SessionContext { binding: SessionBinding; branch: TaskBranch | null; lane: LaneSeed; runtime: SessionKindConfig }

/** The session's node was removed: no node runs its work until it is moved to another (`Sessions.move`). */
export class SessionNodeRemovedError extends Error {
  constructor() {
    super("This session's node was removed; move it to another node to continue");
    this.name = "SessionNodeRemovedError";
  }
}

/** One session, as its row was when it was read, on `nodes` (the app's, or the current app's for a runtime). */
export class SessionModel {
  private built: SourceModel | undefined;

  constructor(
    readonly row: SessionRow,
    private readonly nodes: Pick<NodeHub, "get">,
  ) {}

  get id(): string { return this.row.id; }
  /** Null for a session of no project. */
  get projectId(): number | null { return this.row.project_id; }
  /** Null for a session of no task (always, for a session of no project). */
  get taskId(): number | null { return this.row.task_id; }

  /** Its task (one of its project's: `Sessions.create` checks it), or null. */
  get task(): TaskRow | null {
    return this.row.task_id === null ? null : getTask(this.row.task_id);
  }

  /** Where the session works: its source, on its node (`SourceNotFoundError` if it is gone; none is deleted). */
  get source(): SourceModel {
    return this.built ??= new SourceModel(this.nodes, resolveSource(this.row.source_id));
  }

  /** What its diffs compare with: its project's base branch, or `HEAD` for a session of no project. */
  get baseBranch(): string {
    if (this.row.project_id === null) return NO_BASE_BRANCH;
    const project = getProject(this.row.project_id);
    if (!project) throw new Error(`Project ${this.row.project_id} not found`);
    return project.base_branch;
  }

  /** The files and diffs of its checkout, against its base branch: what its views read. */
  get workspace(): Workspace {
    return this.source.workspace(this.baseBranch);
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

  /** The session's context (`SessionContext`) in `source`, built from the rows now, so task and prompt edits (an
   * extension's included) reach the runtime the next time it opens; `promptSections` gives the app's extensions' sections
   * (`App.promptSections`; none by default). Throws when the lane seed cannot be built (an unusable
   * `default_model`) or the session's kind is unknown. */
  async context(source: Source, promptSections: (context: PromptContext) => Promise<string[]> = async () => []): Promise<SessionContext> {
    const { row } = this;
    const task = row.task_id === null ? null : getTask(row.task_id);
    const { branch = null, ...runtime } = await sessionKind(row.kind)({
      session: row, task,
      promptSections: tools => promptSections({
        session: { id: row.id, projectId: row.project_id, taskId: row.task_id },
        task: task && { id: task.id, title: task.title, description: task.description },
        tools,
      }),
    });
    const project = branch && task && row.project_id !== null ? getProject(row.project_id) : null;
    const taskBranch: TaskBranch | null = branch && task && project
      ? { name: branch, base: project.base_branch, baseCommitKnown: task.base_commit !== null, recordBaseCommit: commit => { updateTask(task.id, { base_commit: commit }); } }
      : null;
    return { binding: this.binding(source), branch: taskBranch, lane: laneSeed(this.row), runtime };
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
