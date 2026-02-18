/**
 * Router
 *
 * Hash-based route parsing and navigation helpers.
 *
 * Routes:
 *  - `#/project/:id`                    — project, no specific session
 *  - `#/project/:id/session/:sessionId` — project + session
 *  - (empty hash)                       — no project selected
 */

export interface Route {
  projectId: number | null;
  sessionId: string | null;
}

/** Parse the current hash into project + session IDs. */
export function parseHash(): Route {
  // #/project/3/session/abc-123
  const full = location.hash.match(/^#\/project\/(\d+)\/session\/(.+)$/);
  if (full) return { projectId: parseInt(full[1], 10), sessionId: decodeURIComponent(full[2]) };

  // #/project/3
  const proj = location.hash.match(/^#\/project\/(\d+)$/);
  if (proj) return { projectId: parseInt(proj[1], 10), sessionId: null };

  return { projectId: null, sessionId: null };
}

/** Build a hash string for a given project + optional session. */
function buildHash(projectId: number, sessionId?: string): string {
  if (sessionId) return `#/project/${projectId}/session/${encodeURIComponent(sessionId)}`;
  return `#/project/${projectId}`;
}

/**
 * Navigate to a session URL.
 * Uses replaceState when `replace` is true (e.g. redirecting from a bare
 * project URL to include the resolved session ID).
 */
export function navigateToSession(projectId: number, sessionId: string, replace = false): void {
  const hash = buildHash(projectId, sessionId);
  if (location.hash === hash) return;
  if (replace) {
    history.replaceState(null, "", hash);
  } else {
    location.hash = hash;
    return; // hashchange event will fire
  }
  // replaceState doesn't fire hashchange — dispatch manually
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
