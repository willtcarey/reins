/**
 * What an app offers the session runtimes the process keeps (`App`, ADR-029): its hub to reach a source's
 * node, its handlers for the Reins tools, and the identity of its code (`APP_CODE`). The app registers it
 * with the process when it starts (`ServerProcess.registerApp`) and stops it when it stops: scripts it
 * still runs are aborted, and their tool calls come back "may have run". Run lifecycle does not go
 * through it: a runtime applies its own (`sessions/session-runs.ts`).
 */
import type { App, AppState } from "./state.js";
import { getNode } from "./node-store.js";
import { Models } from "./models/models.js";
import { serverToolCalls, sessionToolScope, type ReinsToolCalls } from "./tools/index.js";
import { SessionInstance } from "./sessions/session-instance.js";
import { APP_CODE } from "./session-runtime/live.js";

/** A failure with the outcome the runtime's tools tell the model (`App.executeScript`). */
const failure = (message: string, outcome: "unknown" | "not_run") => Object.assign(new Error(message), { outcome });

/** This app as session runtimes reach it, and `stop`, which ends what it still runs for them (its scripts). */
export function createApp(state: AppState): App & { stop(): void } {
  /** Scripts running for runtimes: aborted when the app stops. */
  const scripts = new Set<AbortController>();
  let stopped = false;
  const toolCalls = (sessionId: string): ReinsToolCalls => {
    const models = new Models(state);
    return serverToolCalls({
      ...sessionToolScope(sessionId), sessionId,
      broadcast: models.broadcast, nodes: state.nodes, models, instance: new SessionInstance(state, sessionId),
    });
  };
  return {
    code: APP_CODE,
    node(nodeId) {
      if (getNode(nodeId)?.removedAt) throw new Error(`Node removed: ${nodeId}`);
      return state.nodes.get(nodeId);
    },
    async executeScript(sessionId, code, signal) {
      const calls = toolCalls(sessionId);
      if (stopped) throw failure("The server is reloading", "not_run");
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      scripts.add(controller);
      try {
        const result = await calls.executeScript(code, controller.signal);
        if (stopped && !signal?.aborted) throw failure("The server reloaded while the script ran", "unknown");
        return result;
      } finally {
        scripts.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
    searchScript: (sessionId, query, signal) => toolCalls(sessionId).searchScript(query, signal),
    createTask: (sessionId, input, signal) => toolCalls(sessionId).createTask(input, signal),
    stop() {
      stopped = true;
      for (const script of scripts) script.abort(new Error("The server reloaded"));
    },
  };
}
