/**
 * Live session runtimes on the server (ADR-029). A session's runtime is opened from its rows on first
 * use and kept in the process's map (`OpenSessions.live`) until the process's idle sweep closes it,
 * so it outlives the app that built it. Concurrent opens of one session share one opening. Everything
 * here takes the `ServerProcess`, which a runtime may keep, never the app's state.
 */
import type { OpenSession, ServerProcess, SessionRuntime } from "../state.js";
import { getSession } from "../session-store.js";
import { SessionModel } from "../models/session.js";
import { SessionNotFoundError } from "../models/sessions.js";
import { resolveSource } from "../models/sources.js";
import { logger } from "../logger.js";
import { buildSessionRuntime, type ModelOverride } from "./build.js";

/** The identity of this code: one per app bundle, which each reload builds anew. Its app carries it
 * (`App.code`), so a runtime this code opens while another app's code is current (a runtime of an older
 * app opening its parent's to report to it) is retired at once, and the current code reopens it once it
 * is idle. */
export const APP_CODE = Symbol("app code");

/** The session's runtime runs under another binding (the session was moved) and cannot be closed yet. */
export class SessionRuntimeBusyError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is running under another binding`);
    this.name = "SessionRuntimeBusyError";
  }
}

export interface OpenOptions {
  /** A model the caller is about to set (a model change): it opens the runtime in place of the lane's,
   * so a lane Pi has not created yet is seeded with it and one whose model is gone can be repaired. A
   * runtime already open is used as it is. */
  model?: ModelOverride;
}

/**
 * The session's live runtime, opened from its rows now if it has none (what `SessionModel.context` builds:
 * its binding, branch, lane seed and its kind's runtime configuration; the model validated against the
 * server's catalog). Each call reads the row and checks the session can run, live runtime or not: callers
 * leave those checks to it. One open under another binding (the session moved) or built by an earlier app
 * (`retired`; also one this code opens while another app's is current, `APP_CODE`) is closed and
 * reopened when idle; while it runs, the retired one is used as it is and the moved one refused
 * (`SessionRuntimeBusyError`). One a storage failure faulted is reopened whatever it does. Throws `SessionNotFoundError`, `SourceNotFoundError`, `SessionNodeRemovedError` and what
 * building throws (`ModelNotFoundError`, `UnknownToolsError`).
 */
export async function openSessionRuntime(serverProcess: ServerProcess, sessionId: string, { model }: OpenOptions = {}): Promise<SessionRuntime> {
  // Synchronous up to `opening.set`, so concurrent opens find each other's.
  const { live, opening } = serverProcess.sessions;
  const row = getSession(sessionId);
  if (!row) throw new SessionNotFoundError(`Session not found: ${sessionId}`);
  const session = new SessionModel(row);
  const source = resolveSource(row.project_id, row.source_id);
  session.assertRunnable(source);
  const binding = JSON.stringify(session.binding(source));
  const current = live.get(sessionId);
  if (current && current.binding === binding && !current.retired && !current.faulted) {
    current.lastActivity = Date.now();
    return current.runtime;
  }
  const pending = opening.get(sessionId);
  if (pending) return pending;
  const opened = (async () => {
    const existing = live.get(sessionId);
    if (existing && !existing.faulted && existing.runtime.isStreaming()) {
      if (existing.binding !== binding) throw new SessionRuntimeBusyError(sessionId);
      // Retired while it runs: it keeps its code until it goes idle.
      existing.lastActivity = Date.now();
      return existing.runtime;
    }
    if (existing) {
      live.delete(sessionId);
      // A harness a failed commit faulted rethrows its fault from close: it is released all the same.
      await existing.runtime.close().catch((error: unknown) => logger.warn(`Closing session ${sessionId}'s runtime failed:`, error instanceof Error ? error.message : error));
    }
    let entry: OpenSession | undefined;
    const runtime = await buildSessionRuntime({
      serverProcess, sessionId, projectId: row.project_id, nodeId: source.node_id, context: session.context(source), ...(model ? { model } : {}),
      onActivity: () => { if (entry) entry.lastActivity = Date.now(); },
      onFault: () => { if (entry) entry.faulted = true; },
    });
    const app = serverProcess.app;
    entry = { runtime, binding, lastActivity: Date.now(), retired: app !== undefined && app.code !== APP_CODE, faulted: false };
    live.set(sessionId, entry);
    return runtime;
  })();
  opening.set(sessionId, opened);
  void opened.finally(() => { if (opening.get(sessionId) === opened) opening.delete(sessionId); }).catch(() => undefined);
  return opened;
}

/** Runs `use` on the session's runtime (`openSessionRuntime`). When a storage call failed under it (Pi
 * faulted its harness), the runtime is reopened from storage and `use` runs once more: every use
 * converges on replay (a prompt or steer under its reinsId, an absolute model selection, a resume). */
export async function withSessionRuntime<T>(serverProcess: ServerProcess, sessionId: string, use: (runtime: SessionRuntime) => Promise<T>, options: OpenOptions = {}): Promise<T> {
  try { return await use(await openSessionRuntime(serverProcess, sessionId, options)); }
  catch (error) {
    if (!serverProcess.sessions.live.get(sessionId)?.faulted) throw error;
    return use(await openSessionRuntime(serverProcess, sessionId, options));
  }
}

/** The session's live runtime, if it has one (an opening in progress is waited for); never opens one. */
export async function liveSessionRuntime(serverProcess: ServerProcess, sessionId: string): Promise<SessionRuntime | undefined> {
  await serverProcess.sessions.opening.get(sessionId)?.catch(() => undefined);
  return serverProcess.sessions.live.get(sessionId)?.runtime;
}

/** Closes the live runtimes of sessions about to be deleted, aborting their runs, until none of them is
 * open: a child's run ending reports to its parent, which may open the parent's runtime again. */
export async function closeSessionRuntimes(serverProcess: ServerProcess, sessionIds: readonly string[]): Promise<void> {
  const { sessions } = serverProcess;
  const open = () => sessionIds.filter(id => sessions.live.has(id) || sessions.opening.has(id) || sessions.submissions.has(id));
  for (let round = 0; round < 5 && open().length > 0; round++) {
    await Promise.all(open().map(async id => {
      await sessions.submissions.get(id);
      await closeSessionRuntime(serverProcess, id);
    }));
  }
}

/** Closes the session's live runtime, if it has one, aborting its run (the session was deleted, moved or
 * its node removed). Never rejects. */
export async function closeSessionRuntime(serverProcess: ServerProcess, sessionId: string): Promise<void> {
  const { sessions } = serverProcess;
  await sessions.opening.get(sessionId)?.catch(() => undefined);
  const entry = sessions.live.get(sessionId);
  if (!entry) return;
  sessions.live.delete(sessionId);
  try { await entry.runtime.close(); }
  catch (error) { logger.warn(`Closing session ${sessionId}'s runtime failed:`, error instanceof Error ? error.message : error); }
}
