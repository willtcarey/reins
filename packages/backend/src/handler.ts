/**
 * HTTP Fetch Handler
 *
 * Thin entry point: every endpoint is a route (`routes/`), the WebSocket upgrades (`/ws`, `/nodes/link`)
 * and the node's install script and bundle (`/nodes/*`) included; any other path is a static file. An
 * /api or /nodes path no route matches is a 404, never the web app's SPA fallback.
 */

import type { AppState, UpgradeServer } from "./state.js";
import { API } from "./api-paths.js";
import { buildRouter } from "./routes/index.js";
import { serveStatic } from "./static.js";
import { logger } from "./logger.js";
import { describeTiming, timeRequest, type RequestTiming } from "./request-timing.js";

const router = buildRouter();

/** Slower requests log at info, so a UI that hangs shows in the dev log whether the server was the wait. */
const SLOW_REQUEST_MS = 300;

/** Undefined once a route upgraded the request to a WebSocket (Bun answers it). */
export async function handleFetch(
  state: AppState,
  req: Request,
  server: UpgradeServer,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const startedAt = performance.now();
  let status = "threw";
  let timing: RequestTiming | undefined;
  try {
    const [response, spent] = await timeRequest(() => route(state, req, url, server));
    timing = spent;
    status = response ? String(response.status) : "upgraded";
    return response;
  } finally {
    // Until the response's headers, not its body. Path only: a query can carry tokens.
    const durationMs = Math.round(performance.now() - startedAt);
    const line = `${req.method} ${url.pathname} ${status} ${durationMs}ms${detail(timing)}`;
    if (durationMs >= SLOW_REQUEST_MS) logger.info(line);
    else logger.debug(line);
  }
}

/** Where the time went, when it says something: the request's phases, or the event loop held up. */
const NOTABLE_LAG_MS = 20;
function detail(timing: RequestTiming | undefined): string {
  if (!timing || (timing.phases.size === 0 && timing.maxLagMs < NOTABLE_LAG_MS)) return "";
  return ` ${describeTiming(timing)}`;
}

async function route(state: AppState, req: Request, url: URL, server: UpgradeServer): Promise<Response | undefined> {
  const response = await router.handle(req, state, server);
  if (response !== null) return response;
  if (within(url.pathname, "/api")) {
    return Response.json({ error: `No API route ${req.method} ${url.pathname}` }, { status: 404 });
  }
  if (within(url.pathname, API.remoteNodes)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // Static file serving (frontend)
  return serveStatic(state.process.frontendDir, url.pathname);
}

/** Whether `pathname` is `prefix` or under it. */
function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
