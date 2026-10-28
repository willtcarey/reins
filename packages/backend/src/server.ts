/**
 * The app: what the process owner (`server-process.ts`) loads and swaps on every reload. In dev it is
 * bundled from this entry, so every source it reaches shares one module scope per app.
 *
 * `start` starts one app: it prepares the process's database (migrations, and `injectProcessState` for the stores:
 * the database and the open sessions they derive running sessions from),
 * builds the app's state (a new node hub and its `/nodes/link` endpoint, around the process), starts
 * building the node bundle in the background (served at `/nodes/*`; a failed build is logged, not fatal),
 * listens on the node socket and registers what it offers the process's session runtimes
 * (`ServerProcess.registerApp`: the runtimes the process keeps reach this app from now on). The process's
 * first app also resumes the runs the previous process left running (`recoverRuns`). `stop` unregisters
 * it and closes the hub, listener and remote node links (each node's connection drops and it redials
 * whichever app is next). The database is the process's: no app closes it (docs/dev/hot-reload.md).
 */
import type { ServerProcess, WebSocketLike } from "./state.js";
import { handleFetch } from "./handler.js";
import { handleWsMessage } from "./ws.js";
import { prepareDatabase, injectProcessState } from "./app-globals.js";
import { createAppState } from "./state.js";
import { listenLocalNodeSocket } from "./nodes/local-socket.js";
import { buildNodeBundle } from "./node-bundle/build.js";
import { serveNodeBundle } from "./node-bundle/delivery.js";
import { createApp } from "./app.js";
import { sessionRuns } from "./sessions/session-runs.js";
import { logger } from "./logger.js";

/** A started app: the HTTP and browser WebSocket message handlers the process's server delegates to. */
export interface RunningApp {
  fetch(req: Request, server: Parameters<typeof handleFetch>[2]): Promise<Response | undefined>;
  /** A message from a browser socket the process registered. */
  message(ws: WebSocketLike, message: string | Buffer): void;
  /** Unregisters the app from the process (session runtimes find no app until the next one), aborts the
   * scripts it runs for sessions and closes its node hub, listener and remote node links. */
  stop(): Promise<void>;
}

export interface StartOptions {
  /** The process's first app: it resumes the runs a previous process left running (at process start only:
   * a reload leaves runtimes in memory, so it has nothing to recover). */
  recoverRuns?: boolean;
}

/** Starts an app in `serverProcess`. The previous app must have stopped (its `stop` resolved): only one
 * listener binds the socket. */
export async function start(serverProcess: ServerProcess, { recoverRuns = false }: StartOptions = {}): Promise<RunningApp> {
  injectProcessState(serverProcess);
  prepareDatabase(serverProcess.db);
  // REINS_TEST_FAUX_PROVIDER is a TEST HOOK ONLY (pi/test-faux-provider.ts): process tests drive a
  // scripted model in the sessions this server runs. Never set it in production.
  const testFauxProvider = process.env.REINS_TEST_FAUX_PROVIDER?.trim();
  if (testFauxProvider) {
    const { registerTestFauxProvider } = await import("./pi/test-faux-provider.js");
    registerTestFauxProvider(testFauxProvider);
    logger.info(`TEST: registered faux provider ${testFauxProvider}`);
  }
  // REINS_NODE_BUNDLE_TEST_BUILD is a TEST HOOK ONLY: process tests serve a test build of the node bundle,
  // so restarting the server without it is another build. Never set it in production.
  const bundle = buildNodeBundle({ testBuild: process.env.REINS_NODE_BUNDLE_TEST_BUILD === "1" });
  const state = createAppState(serverProcess, serveNodeBundle(bundle, { bunVersion: Bun.version }));
  const listener = await listenLocalNodeSocket(serverProcess.nodeSocket, socket => state.nodes.accept(socket))
    .catch(async (error: unknown) => { await state.nodes.close(); throw error; });
  const app = createApp(state);
  const unregister = serverProcess.registerApp(app);
  if (recoverRuns) {
    void sessionRuns(state).recoverInterruptedRuns()
      .catch((error: unknown) => logger.error("Recovering interrupted runs failed:", error));
  }
  return {
    fetch: (req, bunServer) => handleFetch(state, req, bunServer),
    message: (ws, message) => handleWsMessage(ws, message),
    async stop() {
      unregister();
      app.stop();
      const closed = state.nodes.close();
      listener.stop();
      state.nodeLinks.close();
      await closed;
    },
  };
}
