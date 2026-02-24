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

/**
 * Closure type for running a sub-session. Built in sessions.ts where
 * ServerState is available, so tools never touch server state directly.
 */
export type RunSubSession = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<{ sessionId: string; summary: string; messageCount: number }>;

const MAX_DEPTH = 3;

const AUTONOMY_PREAMBLE = `You are a sub-agent working on a delegated piece of work. Do not ask clarifying questions — work with what you have, and if you get stuck or need more context, say so in your final message so the caller can help.

---

`;

const parameters = Type.Object({
  prompt: Type.String({
    description:
      "Instructions for the sub-session. Be specific — the sub-session has no prior context. " +
      "You can also specify what you want back (e.g. a summary, a list of changes, a yes/no answer).",
  }),
});

/**
 * Factory that creates the delegate tool definition.
 *
 * @param runSubSession Closure that creates, prompts, and cleans up a sub-session.
 *   Already captures parent session ID and project context.
 * @param depth Current delegation depth (0 = top-level session)
 */
export function createDelegateTool(
  runSubSession: RunSubSession,
  depth: number,
): ToolDefinition {
  return {
    name: "delegate",
    label: "Delegate",
    description:
      "Start a sub-session to do a focused unit of work, then return the result. " +
      "The sub-session gets a fresh context window and full access to coding tools. " +
      "Use this to break large tasks into smaller pieces, keeping each sub-session's context lean.",
    parameters,

    async execute(_toolCallId, params, signal) {
      // Depth guard
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

      try {
        const fullPrompt = AUTONOMY_PREAMBLE + params.prompt;
        const result = await runSubSession(fullPrompt, signal);

        return {
          content: [{ type: "text" as const, text: result.summary }],
          details: {
            sessionId: result.sessionId,
            messageCount: result.messageCount,
          },
        };
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
