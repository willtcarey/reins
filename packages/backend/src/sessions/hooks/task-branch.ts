/**
 * Reins' own `beforeRun` hook (`core.ts`): an open task's own branch checked out in its session's checkout, made there if missing (docs/dev/session-runtime.md *Preparing a
 * run*).
 */
import type { BeforeRun } from "@reins/sdk/server";
import { Git } from "../../git.js";
import { NodeDirClient } from "../../nodes/node-dir-client.js";
import { getProject } from "../../project-store.js";
import { currentAppNode } from "../../session-runtime/build.js";
import type { ServerProcess } from "../../state.js";
import { getTask, updateTask } from "../../task-store.js";

/** The checkout could not be prepared, definitively (not because its node is unreachable): a git failure. */
export class CheckoutPreparationError extends Error {
  readonly code = "checkout_unavailable";
  constructor(message: string, options?: ErrorOptions) {
    super(`Preparing the checkout failed: ${message}`, options);
    this.name = "CheckoutPreparationError";
  }
}

/** The task's branch was there before (the task has a base) and is gone, here and on origin: it is not made
 * again from the base branch. */
export class BranchDeletedError extends Error {
  readonly code = "branch_deleted";
  constructor(branch: string) {
    super(`This task's branch, ${branch}, was deleted. Make it again, or close the task.`);
    this.name = "BranchDeletedError";
  }
}

/** The preparation running in each checkout (by node and path). Git takes one command at a time in a
 * checkout (`index.lock`), and two runs of a task would both make its branch: they take turns. */
const preparing = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, prepare: () => Promise<T>): Promise<T> {
  const before = preparing.get(key) ?? Promise.resolve();
  const turn = before.catch(() => {}).then(prepare);
  const settled = turn.catch(() => {});
  preparing.set(key, settled);
  void settled.then(() => { if (preparing.get(key) === settled) preparing.delete(key); });
  return turn;
}

/** Where the branch begins is only shown: one with no common history with the base branch has none. */
async function recordBaseCommit(git: Git, taskId: number, base: string, branch: string): Promise<void> {
  const commit = await git.mergeBase(base, branch).catch(() => null);
  if (commit) updateTask(taskId, { base_commit: commit });
}

/**
 * Checks out the run's task's own branch unless it is checked out: an open task's with a `branch_name`, of a session
 * offered tools (a utility kind has no checkout). A checkout without it gets it (`Git.ensureBranch`: origin's if
 * pushed, else new from the project's base branch), except a branch that was there before (the task has a base):
 * `BranchDeletedError`. Where a branch made or adopted here begins is recorded as the task's base. The task is read
 * again in the checkout's turn, so a run after another of its task sees the base that one recorded; the whole is
 * repeated when the node's link drops midway, as it is safe to repeat. Git runs through the current app's node, as
 * a runtime's calls do: a reload does not cut it off.
 */
export async function checkOutTaskBranch(serverProcess: ServerProcess, { session, task, tools, signal }: BeforeRun): Promise<void> {
  if (!task?.branchName || task.status === "closed" || session.projectId === null || (tools !== null && tools.length === 0)) return;
  const project = getProject(session.projectId);
  if (!project) return;
  const checkout = new NodeDirClient({ cwd: session.source.path, node: currentAppNode(serverProcess, session.source.nodeId) });
  try {
    await oneAtATime(`${session.source.nodeId}\0${session.source.path}`, () => checkout.repeat(async () => {
      const current = getTask(task.id);
      if (!current?.branch_name || current.status === "closed") return;
      const { branch_name: name, base_commit: baseCommit } = current;
      const git = new Git(checkout.spawner({ signal }));
      if (await git.getCurrentBranch() === name) {
        if (baseCommit === null) await recordBaseCommit(git, task.id, project.base_branch, name);
        return;
      }
      const made = await git.ensureBranch(name, project.base_branch, { create: baseCommit === null });
      if (made === "missing") throw new BranchDeletedError(name);
      await git.checkoutBranch(name);
      if (made !== "existing" || baseCommit === null) await recordBaseCommit(git, task.id, project.base_branch, name);
    }, { signal }));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BranchDeletedError) throw error;
    throw new CheckoutPreparationError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
