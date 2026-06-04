/**
 * delegate Tool
 *
 * Spawns a sub-session on the current task with a fresh context window,
 * awaits its completion, and returns the final assistant message as a summary.
 * Enables work decomposition: the parent agent can break large tasks into
 * focused sub-sessions, keeping each one's context lean.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ManagedSession } from "../state.js";
import { getSession } from "../session-store.js";
import { getProject } from "../project-store.js";
import { ThinkingLevelSchema } from "../models/model-settings.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Per-project mutex for delegation
// ---------------------------------------------------------------------------

const projectMutexes = new Map<number, Promise<void>>();

/**
 * Serialize async work per project. Returns a release function.
 * Prevents concurrent delegate calls from conflicting on the working tree.
 */
function acquireProjectMutex(projectId: number): Promise<() => void> {
  const prev = projectMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  projectMutexes.set(projectId, next);
  return prev.then(() => release);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateSessionOpts {
  taskId?: number;
  delegateDepth?: number;
  parentSessionId?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

/**
 * Creates a new session. State is already curried in by the caller.
 */
export type CreateSessionFn = (
  projectId: number,
  projectDir: string,
  opts?: CreateSessionOpts,
) => Promise<ManagedSession>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;

/**
 * Preamble prepended to sub-session prompts to enforce autonomous execution.
 */
const AUTONOMY_PREAMBLE = `You are a sub-agent working on a delegated piece of work. Do not ask clarifying questions — work with what you have, and if you get stuck or need more context, say so in your final message so the caller can help.

---

`;

/**
 * Walk the parent_session_id chain to compute the current delegation depth.
 */
function getSessionDepth(sessionId: string): number {
  let depth = 0;
  let currentId: string | null = sessionId;
  while (currentId) {
    const row = getSession(currentId);
    if (!row || !row.parent_session_id) break;
    depth++;
    currentId = row.parent_session_id;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const parameters = Type.Object({
  prompt: Type.String({
    description:
      "Instructions for the sub-session. Be specific — the sub-session has no prior context. " +
      "You can also specify what you want back (e.g. a summary, a list of changes, a yes/no answer).",
  }),
  modelProvider: Type.Optional(Type.String({
    description: "Optional provider override for the sub-session (for example 'anthropic' or 'openai'). Requires modelId.",
  })),
  modelId: Type.Optional(Type.String({
    description: "Optional model ID override for the sub-session. Requires modelProvider.",
  })),
  thinkingLevel: Type.Optional(Type.String({
    description: `Optional thinking level override for the sub-session (${ThinkingLevelSchema.description}).`,
  })),
});

/**
 * Factory that creates the delegate tool definition.
 *
 * Stateless: receives server state and session ID at factory time,
 * looks up everything else from the DB at execution time.
 *
 * @param sessionId The parent session ID
 * @param createSession Function to create a new session (state already curried in)
 * @param deleteSession Removes a session from in-memory state after completion
 */
export function createDelegateTool(
  sessionId: string,
  createSession: CreateSessionFn,
  deleteSession: (id: string) => void,
): ToolDefinition<typeof parameters> {
  return {
    name: "delegate",
    label: "Delegate",
    description:
      "Start a sub-session to do a focused unit of work, then return the result. " +
      "The sub-session gets a fresh context window and full access to coding tools. " +
      "Only use this when the user explicitly asks you to delegate or break work into sub-sessions " +
      "— do not proactively delegate.",
    parameters,

    async execute(_toolCallId, params, signal) {
      try {
        // Look up session and project from DB
        const sessionRow = getSession(sessionId);
        if (!sessionRow) {
          return {
            content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
            details: null,
          };
        }

        if (!sessionRow.task_id) {
          return {
            content: [{ type: "text" as const, text: "Error: Delegation is only available in task sessions." }],
            details: null,
          };
        }

        const project = getProject(sessionRow.project_id);
        if (!project) {
          return {
            content: [{ type: "text" as const, text: `Error: Project not found: ${sessionRow.project_id}` }],
            details: null,
          };
        }

        // Depth guard
        const depth = getSessionDepth(sessionId);
        if (depth >= MAX_DEPTH) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Maximum delegation depth (${MAX_DEPTH}) reached. Cannot delegate further.`,
              },
            ],
            details: null,
          };
        }

        // Acquire project mutex to serialize working-tree access
        const release = await acquireProjectMutex(sessionRow.project_id);

        try {
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }

          const inheritedModelProvider = sessionRow.model_provider ?? undefined;
          const inheritedModelId = sessionRow.model_id ?? undefined;
          const inheritedThinkingLevel = sessionRow.thinking_level !== "off"
            ? sessionRow.thinking_level
            : undefined;

          if ((params.modelProvider && !params.modelId) || (!params.modelProvider && params.modelId)) {
            throw new Error("Both modelProvider and modelId are required when overriding a delegate session model.");
          }

          const fullPrompt = AUTONOMY_PREAMBLE + params.prompt;

          const selectedProvider = params.modelProvider ?? inheritedModelProvider;
          const selectedModelId = params.modelId ?? inheritedModelId;

          const managed = await createSession(sessionRow.project_id, project.path, {
            taskId: sessionRow.task_id,
            delegateDepth: depth + 1,
            parentSessionId: sessionId,
            model: selectedProvider && selectedModelId
              ? { provider: selectedProvider, modelId: selectedModelId }
              : undefined,
            thinkingLevel: params.thinkingLevel ?? inheritedThinkingLevel,
          });

          const subRuntime = managed.runtime;
          const subSessionId = managed.id;

          // Wire up abort propagation
          const onAbort = () => {
            subRuntime.abort().catch(() => {});
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          try {
            await subRuntime.prompt([{ type: "text", text: fullPrompt }]);

            // Extract the final assistant message
            const messages = await subRuntime.getMessages();
            let summary = "(No response from sub-session)";
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg.role === "assistant") {
                const blocks = Array.isArray(msg.content) ? msg.content : [];
                const textParts: string[] = [];
                for (const block of blocks) {
                  if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
                    textParts.push(String(block.text));
                  }
                }
                if (textParts.length > 0) {
                  summary = textParts.join("\n");
                  break;
                }
              }
            }

            const messageCount = messages.length;

            logger.info(`  Delegate sub-session ${subSessionId} completed (${messageCount} messages)`);
            return {
              content: [{ type: "text" as const, text: summary }],
              details: {
                sessionId: subSessionId,
                messageCount,
              },
            };
          } finally {
            signal?.removeEventListener("abort", onAbort);
            // Always clean up: close runtime and remove from in-memory state
            // (already persisted to SQLite via turn_end/agent_end events)
            await subRuntime.close();
            deleteSession(subSessionId);
          }
        } finally {
          release();
        }
      } catch (err: any) {
        // AbortError means the parent was cancelled
        if (err.name === "AbortError" || signal?.aborted) {
          return {
            content: [
              { type: "text" as const, text: "Delegation aborted — parent session was cancelled." },
            ],
            details: null,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          details: null,
        };
      }
    },
  };
}
