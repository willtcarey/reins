import type { SystemPromptContext, SessionKind } from "@reins/sdk/server";
import type { SessionRow } from "../session-store.js";
import type { TaskRow } from "../task-store.js";
import { reinsSystemPrompt } from "./system-prompt.js";

/** How a session runs: the system prompt, the tools the model is offered (absent: every tool; a name the
 * runtime does not have fails its opening) and whether the environment is appended to the prompt (the
 * active tools, the REINS docs, context files and skills). */
export interface SessionKindConfig { systemPrompt: string; tools?: string[]; environment: boolean }

/** What a session's runtime configuration is built from: its row, its task's (null: none) and the system prompt
 * sections of the app's extensions for the tools it offers (null: every tool). */
export interface SessionOpening {
  session: SessionRow;
  task: TaskRow | null;
  systemPromptSections(tools: readonly string[] | null): Promise<string[]>;
}

/** Where the app's extensions' kinds and sections are found (`App`): the current app's, read when a runtime opens. */
export interface SessionKindSource {
  systemPromptSections(context: SystemPromptContext): Promise<string[]>;
  /** The extension kind stored as `name` (`<extension>/<name>`), or why there is none. */
  findSessionKind?(name: string): Promise<{ kind: SessionKind } | { missing: string }>;
}

/** Every session is of this kind unless created as another; existing sessions are (migration 046). */
export const DEFAULT_SESSION_KIND = "agent";

/** The browser's tabs of a kind's sessions, by view name: those pinned in the Inspector and the main area's. */
export interface SessionKindViews { pinned: string[]; main: string[] }

/** The Reins agent: Reins' prompt for the session's task (or the project assistant's, for a scratch session)
 * with the extensions' sections, every tool, the environment, and its task's branch checked out. The browser
 * pins its Changes tree and gives it a Changes tab. */
const agent: SessionKind = {
  systemPrompt: context => context.reinsSystemPrompt(),
  pinnedViews: ["diff-file-tree"],
  mainViews: ["session", "session-changes"],
};

/** Task generation (`sessions/task-generator.ts`): parses freeform intent into a task as JSON. */
export const TASK_GENERATOR_KIND = "task-generator";

const TASK_GENERATOR_PROMPT = `You parse user intent into a structured task definition. Given a freeform description of what someone wants to do, return a JSON object with exactly these fields:

- "title": A concise task title (3-5 words, imperative mood, e.g. "Add dark mode support")
- "description": A brief description expanding on the intent with actionable detail (1-3 sentences). Include relevant context the user implied but didn't spell out. This is shown to a coding agent as context for what it should work on.
- "branch_name": A git branch name in task/<slug> format (lowercase, hyphens, 2-5 words in the slug)

Return ONLY valid JSON. No markdown fences, no explanation, no extra text.`;

/** A utility kind: exactly its prompt (sections describe tools it is not offered), no tools, no environment, no branch. */
const taskGenerator: SessionKind = { systemPrompt: () => TASK_GENERATOR_PROMPT, tools: [], environment: false };

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

/** The kind stored as `name`: one of Reins' own, else the extension kind `extensionKind` finds; undefined for
 * a kind not registered now. */
export function findSessionKind(name: string, extensionKind: (name: string) => SessionKind | undefined): SessionKind | undefined {
  return BUILT_IN_KINDS.get(name) ?? (kindExtension(name) === null ? undefined : extensionKind(name));
}

/** A session's kind is not registered now (its extension is off, gone, or no longer registers it): the
 * session refuses to run until it is. */
export class SessionKindMissingError extends Error {
  constructor(kind: string, reason: string) {
    super(`This session's kind, ${kind}, is not registered: ${reason}`);
    this.name = "SessionKindMissingError";
  }
}

/** The views of the kind stored as `name` (`findSessionKind`); none for a kind not registered now. */
export function sessionKindViews(name: string, extensionKind: (name: string) => SessionKind | undefined): SessionKindViews {
  const kind = findSessionKind(name, extensionKind);
  return { pinned: [...kind?.pinnedViews ?? []], main: [...kind?.mainViews ?? []] };
}

/** The kind stored as `name`: one of Reins' own, else the extension's from `source`, which waits for an extension
 * still loading. Throws `SessionKindMissingError` when there is none now. */
export async function resolveSessionKind(name: string, source: SessionKindSource | undefined): Promise<SessionKind> {
  const builtIn = BUILT_IN_KINDS.get(name);
  if (builtIn) return builtIn;
  if (kindExtension(name) === null) throw new SessionKindMissingError(name, "Reins has no kind of that name");
  // Between two apps (a reload) no extension is registered: the next app has them again.
  const found = await source?.findSessionKind?.(name) ?? { missing: "Reins is reloading; try again" };
  if ("missing" in found) throw new SessionKindMissingError(name, found.missing);
  return found.kind;
}

/**
 * How a session of `kind` runs, built each time its runtime opens (so prompt text and task edits reach it the next
 * time it opens): the kind's prompt (which may build on Reins' own), then the extensions' sections asked for its
 * tools, its tools (absent: every tool), whether the environment is appended, and the branch checked out before a
 * run. A task session offered tools works on its task's branch, since those tools work in the checkout; one offered
 * none (a utility kind) has no side effects on open.
 */
export async function sessionKindConfig(kind: SessionKind, { session, task, systemPromptSections }: SessionOpening): Promise<SessionKindConfig & { branch?: string }> {
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
}
