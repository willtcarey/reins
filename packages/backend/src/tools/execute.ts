/**
 * execute Tool
 *
 * Runs agent-written async JavaScript against a curated `api` object
 * that exposes Reins internals (tasks, sessions, projects).
 *
 * Code runs inside a Node.js `vm` context so it cannot access the host
 * process, filesystem, network, or native modules. Only the `api` object
 * and safe JS builtins are available.
 *
 * NOTE: The vm sandbox is a lightweight isolation layer — it prevents
 * accidental misuse and casual prompt-injection exploits but is NOT a
 * security boundary against a determined attacker. See docs/tech-debt.md
 * for notes on upgrading to a child-process sandbox if needed.
 *
 * Use the `search` tool first to discover the available API surface.
 */

import { createContext, runInContext } from "node:vm";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";
import { buildApiObject } from "../scripting/api-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteToolOpts {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
  encryptionSecret: Buffer;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;

const parameters = Type.Object({
  code: Type.String({
    description:
      "Async JavaScript function body. Has access to an `api` object with " +
      "tasks, sessions, and projects namespaces. Use `return` to produce a result. " +
      "Use the `search` tool first to discover available API functions.",
  }),
});

/**
 * Format the return value for the agent.
 */
function formatResult(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

export function createExecuteTool(opts: ExecuteToolOpts): ToolDefinition<typeof parameters> {
  return {
    name: "execute",
    label: "Execute",
    description:
      "Run async JavaScript against Reins internals. " +
      "Write a function body using the `api` object (tasks, sessions, projects). " +
      "Use the `search` tool first to discover available API functions and their signatures.",
    parameters,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const api = buildApiObject({
          projectId: opts.projectId,
          sessionId: opts.sessionId,
          taskId: opts.taskId,
          broadcast: opts.broadcast,
          sessions: opts.sessions,
          encryptionSecret: opts.encryptionSecret,
        });

        // Build a vm context with only the api object and safe JS builtins.
        // This prevents access to process, require, import(), fs, network, etc.
        const ctx = createContext({
          api,
          // Safe builtins
          JSON,
          Math,
          Date,
          Array,
          Object,
          String,
          Number,
          Boolean,
          RegExp,
          Error,
          TypeError,
          RangeError,
          Map,
          Set,
          WeakMap,
          WeakSet,
          Promise,
          Symbol,
          parseInt,
          parseFloat,
          isNaN,
          isFinite,
          undefined,
          NaN,
          Infinity,
          // Logging (captured, not host console)
          console: { log: () => {}, warn: () => {}, error: () => {} },
        });

        // Wrap the agent's code in an async IIFE so `return` and `await` work.
        // The trailing newline ensures a closing `//` comment doesn't eat the `})`.
        const wrapped = `(async function(api) { ${params.code}\n})(api)`;

        // Run with timeout
        const result = await runInContext(wrapped, ctx, { timeout: TIMEOUT_MS });

        const text = formatResult(result);

        return {
          content: [{ type: "text" as const, text }],
          details: { success: true },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          details: { success: false, error: err.message },
        };
      }
    },
  };
}
