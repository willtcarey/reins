/**
 * Reins application tools (`create_task`, `search`, `execute`), for a session running on the server.
 *
 * Each tool forwards to one server operation through `ReinsToolCalls`, which the runtime resolves at
 * each call from the handler load serving now (`LoadServices.toolCalls`), bound to the calling session
 * (the load derives project/task scope from its row).
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { HostToolContext } from "./tools.js";
import { reinsToolNames, type ReinsToolCalls, type ScriptExecuteResult } from "@reins/node-protocol";

/* The tool names are shared with the node's copy (the protocol package); descriptions and parameter
 * schemas are the tools' own. A call failing with an `outcome` (`LoadServices.toolCalls`: an object
 * property, not a class, since the load that throws it may run other code than this runtime) classifies
 * a failure: "unknown" may have run (the load stopped under it), "not_run" did not. */
const outcomeOf = (error: unknown) => typeof error === "object" && error !== null && "outcome" in error ? error.outcome : undefined;

export type ReinsTool = AgentHarnessTool<HostToolContext | undefined>;

const text = (value: string) => [{ type: "text" as const, text: value }];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Failure text for side-effecting calls: an unknown outcome is stated, never retried here. */
function failure(error: unknown, unknownOutcome: string, notRun: string): string {
  if (outcomeOf(error) === "unknown") return `Error: ${message(error)}. ${unknownOutcome}`;
  if (outcomeOf(error) === "not_run") return `Error: ${message(error)}. ${notRun}`;
  return `Error: ${message(error)}`;
}

const createTaskParameters = Type.Object({
  title: Type.String({ description: "Concise task title (imperative mood, e.g. \"Add dark mode support\")" }),
  description: Type.String({ description: "Brief description with actionable detail (1-3 sentences)" }),
  branch_name: Type.Optional(
    Type.String({ description: "Git branch name in task/<slug> format. If omitted, derived from the title." }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Optional initial prompt to kick off a session on the new task. " +
        "The session starts in the background (fire-and-forget) — the tool returns immediately. " +
        "Use this to start work on the task right away.",
    }),
  ),
});

const searchParameters = Type.Object({
  query: Type.String({
    description:
      "What you're looking for — a category, function name, or description. " +
      "Use an empty string to inspect the full API surface.",
  }),
});

const executeParameters = Type.Object({
  code: Type.String({
    description:
      "Async JavaScript function body. Has access to the existing `api` object " +
      "for Reins-managed data or UI state. Use `return` to produce a result. " +
      "Use the `search` tool for functions not already documented in the system prompt.",
  }),
});

function createTaskTool(calls: ReinsToolCalls): AgentHarnessTool<HostToolContext | undefined, typeof createTaskParameters> {
  return {
    name: reinsToolNames.createTask,
    label: "Create Task",
    description:
      "Create a new task for the current project with a dedicated git branch. " +
      "Only use this when the user explicitly asks you to create a task — do not proactively create tasks.",
    parameters: createTaskParameters,
    replay: "never",
    async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
      try {
        const { task, sessionStarting } = await calls.createTask({
          title: params.title, description: params.description,
          ...(params.branch_name !== undefined ? { branchName: params.branch_name } : {}),
          ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
        }, context.abortSignal);
        const result: Record<string, unknown> & { _note?: string } = { ...task };
        if (params.prompt) {
          result._note = sessionStarting
            ? "Session started in background — watch for progress via WebSocket events."
            : "Prompt was provided but session creation is not available in this context.";
        }
        return { content: text(JSON.stringify(result, null, 2)), details: task };
      } catch (error) {
        return {
          content: text(failure(error,
            "The outcome is unknown: the task may have been created. Check the project's tasks before retrying.",
            "The task was not created.")),
          details: null,
        };
      }
    },
  };
}

function searchTool(calls: ReinsToolCalls): AgentHarnessTool<HostToolContext | undefined, typeof searchParameters> {
  return {
    name: reinsToolNames.search,
    label: "Search API",
    description:
      "Discover Reins internal API functions available to the `execute` tool. " +
      "Returns documentation-only TypeScript interfaces for the existing `api` object " +
      "and referenced domain types, filtered by query. " +
      "Use this before writing `execute` scripts for Reins-managed data or UI state. " +
      "Use an empty query to inspect the full API surface. " +
      "In `execute` scripts, call methods on the provided `api` object; " +
      "these interfaces are documentation only.",
    parameters: searchParameters,
    // Read-only on the server: a call an interruption cut off is run again.
    replay: "safe",
    async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
      try {
        const result = await calls.searchScript(params.query, context.abortSignal);
        return { content: text(result.text), details: { matchCount: result.matchCount } };
      } catch (error) {
        return { content: text(`Error: ${message(error)}`), details: { matchCount: 0 } };
      }
    },
  };
}

function executeTool(calls: ReinsToolCalls): AgentHarnessTool<HostToolContext | undefined, typeof executeParameters> {
  return {
    name: reinsToolNames.execute,
    label: "Execute",
    description:
      "Run async JavaScript against Reins internals. " +
      "Write a function body using the existing `api` object. " +
      "Use the `search` tool to discover functions not already documented in the system prompt.",
    parameters: executeParameters,
    replay: "never",
    async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
      let result: ScriptExecuteResult;
      try {
        result = await calls.executeScript(params.code, context.abortSignal);
      } catch (error) {
        const reason = message(error);
        return {
          content: text(failure(error,
            "The script's outcome is unknown: it may have run, with side effects. Check before re-running it.",
            "The script did not run.")),
          details: { success: false, error: reason },
        };
      }
      return result.ok
        ? { content: text(result.text), details: { success: true } }
        : { content: text(`Error: ${result.error}`), details: { success: false, error: result.error } };
    },
  };
}

/** The model-visible surface (names, descriptions, parameters) and order are part of the product contract. */
export function createReinsTools(calls: ReinsToolCalls): ReinsTool[] {
  return [createTaskTool(calls), searchTool(calls), executeTool(calls)];
}
