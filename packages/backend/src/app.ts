/**
 * What an app offers process-owned code (`App`, ADR-029): the node hub's questions about the nodes it links
 * (`hub`, `nodes/hub-app.ts`) and, for the session runtimes the process keeps, its handlers for run
 * lifecycle and the Reins tools. The app registers it with the process when it starts
 * (`ServerProcess.registerApp`) and stops it when it stops: scripts it still runs are aborted, and their
 * tool calls come back "may have run".
 */
import type { App, AppState } from "./state.js";
import { createBroadcast } from "./models/broadcast.js";
import { Models } from "./models/models.js";
import { createHubApp, type HubAppOptions } from "./nodes/hub-app.js";
import { serverToolCalls, sessionToolScope, type ReinsToolCalls } from "./tools/index.js";
import { SessionInstance } from "./sessions/session-instance.js";
import { sessionRuns } from "./sessions/session-runs.js";

/** A failure with the outcome the runtime's tools tell the model (`App.executeScript`). */
const failure = (message: string, outcome: "unknown" | "not_run") => Object.assign(new Error(message), { outcome });

/** This app as process-owned code reaches it, and `stop`, which ends what it still runs for session
 * runtimes (their scripts). `hub`: the hub's options of this app (tests). */
export function createApp(state: AppState, { hub }: { hub?: HubAppOptions } = {}): App & { stop(): void } {
  const runs = sessionRuns({ broadcast: createBroadcast(state.process), state });
  /** Scripts running for runtimes: aborted when the app stops. */
  const scripts = new Set<AbortController>();
  let stopped = false;
  const toolCalls = (sessionId: string): ReinsToolCalls => {
    const models = new Models(state);
    return serverToolCalls({
      ...sessionToolScope(sessionId), sessionId,
      broadcast: models.broadcast, nodes: state.process.nodes, models, instance: new SessionInstance(state, sessionId),
    });
  };
  return {
    hub: createHubApp(state, hub),
    runStarted: (sessionId, runId) => runs.runStarted(sessionId, runId),
    runSettled: report => runs.runSettled(report),
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
