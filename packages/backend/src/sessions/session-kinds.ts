import type { SystemPromptContext, SessionKind as ExtensionSessionKind } from "@reins/sdk/server";
import type { SessionRow } from "../session-store.js";
import type { TaskRow } from "../task-store.js";
import { reinsSystemPrompt } from "./system-prompt.js";

/** How a session runs: the system prompt, the tools the model is offered (absent: every tool; a name the
 * runtime does not have fails its opening) and whether the environment is appended to the prompt (the
 * active tools, the REINS docs, context files and skills). */
export interface SessionKindConfig { systemPrompt: string; tools?: string[]; environment: boolean }

/** What a kind resolves a session's runtime configuration from: its row, its task's (null: none) and the
 * system prompt sections of the app's extensions for the tools it offers
 * (null: every tool). */
export interface SessionKindContext {
  session: SessionRow;
  task: TaskRow | null;
  systemPromptSections(tools: readonly string[] | null): Promise<string[]>;
}
/**
 * A session kind: how its sessions run. Resolved every time a session's runtime opens (so prompt text and
 * task edits reach it the next time it opens), into the system prompt, the tools the model is offered
 * (absent: every tool), whether the environment (the tools, REINS docs, context files and skills) is
 * appended to the prompt, and the branch checked out on the session's node before a run (absent: none). A
 * utility kind has no side effects: no tools, no environment, no branch.
 */
export type SessionKind = (context: SessionKindContext) => Promise<SessionKindConfig & { branch?: string }> | SessionKindConfig & { branch?: string };

/** Where the app's extensions' kinds and sections are found (`App`): the current app's, read when a runtime opens. */
export interface SessionKindSource {
  systemPromptSections(context: SystemPromptContext): Promise<string[]>;
  /** The extension kind stored as `name` (`<extension>/<name>`), or why there is none. */
  findSessionKind?(name: string): Promise<{ kind: ExtensionSessionKind } | { missing: string }>;
}

/** Every session is of this kind unless created as another; existing sessions are (migration 046). */
export const DEFAULT_SESSION_KIND = "agent";

/** The Reins agent: the server's Reins prompt for the session's task (or the project assistant's, for a
 * scratch session) with the extensions' sections, every tool, the environment, and its task's branch checked out. */
const agent: SessionKind = async ({ session, task, systemPromptSections }) => ({
  systemPrompt: reinsSystemPrompt({ task: task && { title: task.title, description: task.description }, project: session.project_id !== null, sections: await systemPromptSections(null) }),
  environment: true,
  ...(task ? { branch: task.branch_name } : {}),
});

/** Task generation (`sessions/task-generator.ts`): parses freeform intent into a task as JSON. */
export const TASK_GENERATOR_KIND = "task-generator";

const TASK_GENERATOR_PROMPT = `You parse user intent into a structured task definition. Given a freeform description of what someone wants to do, return a JSON object with exactly these fields:

- "title": A concise task title (3-5 words, imperative mood, e.g. "Add dark mode support")
- "description": A brief description expanding on the intent with actionable detail (1-3 sentences). Include relevant context the user implied but didn't spell out. This is shown to a coding agent as context for what it should work on.
- "branch_name": A git branch name in task/<slug> format (lowercase, hyphens, 2-5 words in the slug)

Return ONLY valid JSON. No markdown fences, no explanation, no extra text.`;

/** A utility kind: exactly its prompt, no tools, no environment, no branch. */
const taskGenerator: SessionKind = () => ({ systemPrompt: TASK_GENERATOR_PROMPT, tools: [], environment: false });

/** Reins' own kinds, fixed in code: each app bundle has its own copy, so a hot reload changes them with the
 * code. Extensions' kinds are their host's (`ExtensionHost.sessionKind`), named `<extension>/<name>`. */
const BUILT_IN_KINDS: ReadonlyMap<string, SessionKind> = new Map([[DEFAULT_SESSION_KIND, agent], [TASK_GENERATOR_KIND, taskGenerator]]);

export const SESSION_KIND_SEPARATOR = "/";

/** How an extension's kind is stored on its sessions. */
export const extensionKindName = (extension: string, name: string) => `${extension}${SESSION_KIND_SEPARATOR}${name}`;

/** The extension of a stored kind, or null for one of Reins' own. */
export function kindExtension(name: string): string | null {
  const at = name.indexOf(SESSION_KIND_SEPARATOR);
  return at > 0 ? name.slice(0, at) : null;
}

export const isBuiltInKind = (name: string) => BUILT_IN_KINDS.has(name);

/** A session's kind is not registered now (its extension is off, gone, or no longer registers it): the
 * session refuses to run until it is. */
export class SessionKindMissingError extends Error {
  constructor(kind: string, reason: string) {
    super(`This session's kind, ${kind}, is not registered: ${reason}`);
    this.name = "SessionKindMissingError";
  }
}

/** The kind stored as `name`: one of Reins' own, else the extension's from `source`. Throws
 * `SessionKindMissingError` when there is none now. */
export async function resolveSessionKind(name: string, source: SessionKindSource | undefined): Promise<SessionKind> {
  const builtIn = BUILT_IN_KINDS.get(name);
  if (builtIn) return builtIn;
  if (kindExtension(name) === null) throw new SessionKindMissingError(name, "Reins has no kind of that name");
  // Between two apps (a reload) no extension is registered: the next app has them again.
  const found = await source?.findSessionKind?.(name) ?? { missing: "Reins is reloading; try again" };
  if ("missing" in found) throw new SessionKindMissingError(name, found.missing);
  return adaptExtensionKind(found.kind);
}

/**
 * An extension's kind as a resolver: its prompt in place of Reins' (which it may build on), every extension's
 * sections after it, its tools and environment. A task session offered tools works on its task's branch, as
 * an agent's does, since those tools work in the checkout; one offered none has no side effects on open.
 */
function adaptExtensionKind(kind: ExtensionSessionKind): SessionKind {
  return async ({ session, task, systemPromptSections }) => {
    const tools = kind.tools ? [...kind.tools] : undefined;
    const prompt = await kind.systemPrompt({
      session: { id: session.id, projectId: session.project_id, taskId: session.task_id, kind: session.kind },
      task: task && { id: task.id, title: task.title, description: task.description },
      reinsSystemPrompt: () => reinsSystemPrompt({ task: task && { title: task.title, description: task.description }, project: session.project_id !== null, ...(tools ? { tools } : {}) }),
    });
    const sections = await systemPromptSections(tools ?? null);
    return {
      systemPrompt: [prompt, ...sections].join("\n\n"),
      ...(tools ? { tools } : {}),
      environment: kind.environment !== false,
      ...(task && (!tools || tools.length > 0) ? { branch: task.branch_name } : {}),
    };
  };
}
