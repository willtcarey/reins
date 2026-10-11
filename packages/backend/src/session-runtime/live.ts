/**
 * Live session runtimes on the server (ADR-029). A session's runtime is opened from its rows on first
 * use and kept in the process's map (`ProcessSessions.live`) until the process's idle sweep closes it,
 * so it outlives the handler load that built it. Concurrent opens of one session share one opening.
 */
import type { LiveRuntime, LiveRuntimeEntry, SessionProcess } from "../state.js";
import { getSession } from "../session-store.js";
import { SessionModel } from "../models/session.js";
import { SessionNotFoundError } from "../models/sessions.js";
import { logger } from "../logger.js";
import { buildSessionRuntime } from "./build.js";

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

/**
 * The session's live runtime, opened from its rows now if it has none (what `SessionModel.context` builds:
 * its binding, branch, lane seed and its kind's runtime configuration; the model validated against the
 * server's catalog). One open under another binding (the session moved) or built by an earlier load
 * (`retired`) is closed and reopened when idle; while it runs, the retired one is used as it is and the
 * moved one refused (`SessionRuntimeBusyError`). One a storage failure faulted is reopened whatever it
 * does. Throws `SessionNotFoundError`, `SessionSourceUnavailableError`, `SessionNodeRemovedError` and what
 * building throws (`ModelNotFoundError`, `UnknownToolsError`).
 */
export async function openSessionRuntime(host: SessionProcess, sessionId: string): Promise<LiveRuntime> {
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
    let entry: LiveRuntimeEntry | undefined;
    const runtime = await buildSessionRuntime({
      host, sessionId, projectId: row.project_id, nodeId: source.node_id, context,
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
