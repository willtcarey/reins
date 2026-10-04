import type { SessionRuntime } from "@reins/node-protocol";
import type { SessionRow } from "../session-store.js";
import type { TaskRow } from "../task-store.js";
import { reinsSystemPrompt } from "./system-prompt.js";

/** What a kind resolves a session's runtime configuration from: its row and its task's (null: none). */
export interface SessionKindContext { session: SessionRow; task: TaskRow | null }
/**
 * A session kind: how its sessions run. Resolved every time the server sends one of them an opening
 * command (so prompt text and task edits reach the node the next time it opens the runtime), into the
 * system prompt, the tools the model is offered (absent: every tool), whether the node appends its
 * environment (the tools, REINS docs, context files and skills) to the prompt, and the branch the node
 * checks out before it opens the runtime (absent: none). A utility kind has no side effects: no tools,
 * no environment, no branch.
 */
export type SessionKind = (context: SessionKindContext) => SessionRuntime & { branch?: string };

/** Every session is of this kind unless created as another; existing sessions are (migration 046). */
export const DEFAULT_SESSION_KIND = "agent";

/** The Reins agent: the server's Reins prompt for the session's task (or the project assistant's, for a
 * scratch session), every tool, the node's environment, and its task's branch checked out. */
const agent: SessionKind = ({ task }) => ({
  systemPrompt: reinsSystemPrompt({ task: task && { title: task.title, description: task.description } }),
  environment: true,
  ...(task ? { branch: task.branch_name } : {}),
});

const kinds = new Map<string, SessionKind>([[DEFAULT_SESSION_KIND, agent]]);

/** Adds a kind (for Reins features and, later, extensions); returns its removal. A name already
 * registered throws. Kinds are validated in code, not by the database: a new kind needs no migration. */
export function registerSessionKind(name: string, kind: SessionKind): () => void {
  if (kinds.has(name)) throw new Error(`Session kind already registered: ${name}`);
  kinds.set(name, kind);
  return () => { if (kinds.get(name) === kind) kinds.delete(name); };
}

/** The kind registered as `name`; throws for an unknown one. */
export function sessionKind(name: string): SessionKind {
  const kind = kinds.get(name);
  if (!kind) throw new Error(`Unknown session kind: ${name}`);
  return kind;
}
