/**
 * The process for tests that replace apps under it: what `server-process.ts` owns across apps (a
 * `ServerProcess` on the test database), with in-process apps registering with it as `start` in
 * `server.ts` does.
 */
import type { ServerProcessOptions } from "../../process-state.js";
import { createApp } from "../../app.js";
import type { App, AppState } from "../../state.js";
import { testProcess, type TestProcess } from "./app-state.js";

/** A test process whose one browser connection records every frame it gets (`frames`). */
export function sessionHost(options?: ServerProcessOptions): TestProcess & { frames: string[] } {
  const frames: string[] = [];
  const serverProcess = testProcess({ clients: new Set([{ ws: { send: frame => { frames.push(frame); return frame.length; } } }]), ...options });
  return Object.assign(serverProcess, { frames });
}

/** `state`'s app registers with its process, as an app does from its start (`wrap` may observe its `App`);
 * the result stops it, as its `stop` does (the process's hub is the caller's to close). */
export function startApp(state: AppState, wrap: (app: App) => App = app => app): () => void {
  const app = createApp(state);
  const unregister = state.process.registerApp(wrap(app));
  return () => { unregister(); app.stop(); };
}

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
