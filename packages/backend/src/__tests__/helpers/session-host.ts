/**
 * The process's sessions for tests: what `server-process.ts` owns across handler loads (the database
 * connection, browser clients and `ProcessSessions`), with in-process loads serving it as `start` in
 * `server.ts` does.
 */
import { getDb } from "../../db.js";
import { createProcessSessions, type ProcessSessionsOptions } from "../../process-state.js";
import { loadServices } from "../../session-runtime/load-services.js";
import type { LoadServices, ServerState, SessionProcess, WsClient } from "../../state.js";
import { closeSessions } from "./server-state.js";

export type TestHost = SessionProcess & { sessions: ReturnType<typeof createProcessSessions> };

/** The process's state on the test database, with browser clients that record every frame they get. */
export function sessionHost(options?: ProcessSessionsOptions): TestHost & { frames: string[] } {
  const frames: string[] = [];
  const clients = new Set<WsClient>([{ ws: { send: frame => { frames.push(frame); return frame.length; } } }]);
  return { db: getDb(), clients, sessions: createProcessSessions(options), frames };
}

/** `state`'s load serves `host`, as a load does from its start (`wrap` may observe its services); the
 * result stops it, as its `stop` does (its hub is the caller's to close). */
export function serveLoad(host: TestHost, state: ServerState, wrap: (services: LoadServices) => LoadServices = services => services): () => void {
  const services = loadServices(state);
  const release = host.sessions.serve(wrap(services));
  return () => { release(); services.stop(); };
}

/** Closes every live runtime of `host` (aborting their runs). */
export const closeLiveRuntimes = (host: TestHost): Promise<void> => closeSessions(host);

/** The browser frames' session events of `sessionId`, parsed, in order. */
export function sessionEvents(frames: readonly string[], sessionId: string): Array<{ seq: number; event: { type: string } & Record<string, unknown> }> {
  return frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === "event" && frame.sessionId === sessionId);
}

/** Polls `condition` every 10 ms until it holds, failing with `what` after `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
