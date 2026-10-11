/**
 * Live session runtimes on the server (ADR-029). A session's runtime is opened from its rows on first
 * use and kept in the process's map (`OpenSessions.live`) until the process's idle sweep closes it,
 * so it outlives the handler load that built it. Concurrent opens of one session share one opening.
 */
import type { OpenSession, ServerProcess, ServerState, SessionRuntime } from "../state.js";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { SessionModel } from "../models/session.js";
import { SessionNotFoundError } from "../models/sessions.js";
import { logger } from "../logger.js";
import { buildSessionRuntime, type ModelOverride } from "./build.js";

/** The session's runtime runs under another binding (the session was moved) and cannot be closed yet. */
export class SessionRuntimeBusyError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is running under another binding`);
    this.name = "SessionRuntimeBusyError";
  }
}

/** A session whose source is gone has nowhere to run. */
export class SessionSourceUnavailableError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} has no source`);
    this.name = "SessionSourceUnavailableError";
  }
}

/** The process's sessions as a load reaches them (of `ServerProcess`): its database connection (the one
 * `getDb` returns), browser clients and `OpenSessions`. */
export function serverProcess(state: Pick<ServerState, "clients" | "sessions">): Pick<ServerProcess, "db" | "clients" | "sessions"> {
  return { db: getDb(), clients: state.clients, sessions: state.sessions };
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
 * server's catalog). One open under another binding (the session moved) or built by an earlier load
 * (`retired`) is closed and reopened when idle; while it runs, the retired one is used as it is and the
 * moved one refused (`SessionRuntimeBusyError`). One a storage failure faulted is reopened whatever it
 * does. Throws `SessionNotFoundError`, `SessionSourceUnavailableError`, `SessionNodeRemovedError` and what
 * building throws (`ModelNotFoundError`, `UnknownToolsError`).
 */
export async function openSessionRuntime(host: Pick<ServerProcess, "db" | "clients" | "sessions">, sessionId: string, { model }: OpenOptions = {}): Promise<SessionRuntime> {
  // Synchronous up to `opening.set`, so concurrent opens find each other's.
  const { live, opening } = host.sessions;
  const row = getSession(sessionId);
  if (!row) throw new SessionNotFoundError(`Session not found: ${sessionId}`);
  const session = new SessionModel(row);
  const source = session.source();
  if (!source) throw new SessionSourceUnavailableError(sessionId);
  session.assertRunnable(source);
  const context = session.context(source);
  const binding = JSON.stringify(context.binding);
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
      host, sessionId, projectId: row.project_id, nodeId: source.node_id, context, ...(model ? { model } : {}),
      onActivity: () => { if (entry) entry.lastActivity = Date.now(); },
      onFault: () => { if (entry) entry.faulted = true; },
    });
    entry = { runtime, binding, lastActivity: Date.now(), retired: false, faulted: false };
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
export async function withSessionRuntime<T>(host: Pick<ServerProcess, "db" | "clients" | "sessions">, sessionId: string, use: (runtime: SessionRuntime) => Promise<T>, options: OpenOptions = {}): Promise<T> {
  try { return await use(await openSessionRuntime(host, sessionId, options)); }
  catch (error) {
    if (!host.sessions.live.get(sessionId)?.faulted) throw error;
    return use(await openSessionRuntime(host, sessionId, options));
  }
}

/** The session's live runtime, if it has one (an opening in progress is waited for); never opens one. */
export async function liveSessionRuntime(host: Pick<ServerProcess, "db" | "clients" | "sessions">, sessionId: string): Promise<SessionRuntime | undefined> {
  await host.sessions.opening.get(sessionId)?.catch(() => undefined);
  return host.sessions.live.get(sessionId)?.runtime;
}

/** Closes the live runtimes of sessions about to be deleted, aborting their runs, until none of them is
 * open: a child's run ending reports to its parent, which may open the parent's runtime again. */
export async function closeSessionRuntimes(host: Pick<ServerProcess, "db" | "clients" | "sessions">, sessionIds: readonly string[]): Promise<void> {
  const open = () => sessionIds.filter(id => host.sessions.live.has(id) || host.sessions.opening.has(id) || host.sessions.submissions.has(id));
  for (let round = 0; round < 5 && open().length > 0; round++) {
    await Promise.all(open().map(async id => {
      await host.sessions.submissions.get(id);
      await closeSessionRuntime(host, id);
    }));
  }
}

/** Closes the session's live runtime, if it has one, aborting its run (the session was deleted, moved or
 * its node removed). Never rejects. */
export async function closeSessionRuntime(host: Pick<ServerProcess, "db" | "clients" | "sessions">, sessionId: string): Promise<void> {
  await host.sessions.opening.get(sessionId)?.catch(() => undefined);
  const entry = host.sessions.live.get(sessionId);
  if (!entry) return;
  host.sessions.live.delete(sessionId);
  try { await entry.runtime.close(); }
  catch (error) { logger.warn(`Closing session ${sessionId}'s runtime failed:`, error instanceof Error ? error.message : error); }
}
