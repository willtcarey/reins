/**
 * Router
 *
 * Hash-based route parsing and navigation helpers.
 *
 * Routes:
 *  - `#/session/:sessionId` — view a session
 *  - (empty hash)           — no session selected
 */

export interface Route {
  sessionId: string | null;
}

/** Parse the current hash into a session ID. */
export function parseHash(): Route {
  // #/session/abc-123
  const match = location.hash.match(/^#\/session\/(.+)$/);
  if (match) return { sessionId: decodeURIComponent(match[1]) };

  // Backward compat: #/project/3/session/abc-123
  const legacy = location.hash.match(/^#\/project\/\d+\/session\/(.+)$/);
  if (legacy) return { sessionId: decodeURIComponent(legacy[1]) };

  return { sessionId: null };
}

/**
 * Navigate to a session URL.
 * Uses replaceState when `replace` is true (e.g. redirecting).
 */
export function navigateToSession(sessionId: string, replace = false): void {
  const hash = `#/session/${encodeURIComponent(sessionId)}`;
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
