/**
 * The handler module: what the process owner (`server-process.ts`) loads and swaps on every reload. In
 * dev it is bundled from this entry, so every source it reaches shares one module scope per load.
 *
 * `start` serves one load: it prepares the process's database (migrations, then recovery of interrupted
 * outbox deliveries), builds the load's state (a new node hub and its `/nodes/link` endpoint), starts
 * building the node bundle in the background (served at `/nodes/*`; a failed build is logged, not
 * fatal), listens on the node socket and serves the process's session runtimes (`ProcessSessions.serve`:
 * the runtimes it keeps reach this load from now on). `stop` closes the hub, listener and remote node
 * links (each node's connection drops and it redials whichever load serves next) and waits for the
 * deliveries in flight to settle. The database is the process's: no load closes it
 * (docs/dev/hot-reload.md).
 */
import type { SessionProcess, WebSocketLike } from "./state.js";
import { handleFetch } from "./handler.js";
import { handleWsMessage } from "./ws.js";
import { prepareDatabase, setDb } from "./db.js";
import { createServerState } from "./state.js";
import { listenLocalNodeSocket } from "./nodes/local-socket.js";
import { buildNodeBundle } from "./node-bundle/build.js";
import { serveNodeBundle } from "./node-bundle/delivery.js";
import { loadServices } from "./session-runtime/load-services.js";

/** What the process owner keeps across loads and hands each one: its database connection, browser
 * clients (which outlive a reload: the process registers each socket, as the HTTP server is the
 * process's) and live sessions (`SessionProcess`), the frontend directory and the node socket path. */
export interface ServerProcess extends SessionProcess {
  frontendDir: string;
  /** The local node socket path the load listens on. */
  nodeSocket: string;
}

/** A started handler load: the HTTP and browser WebSocket message handlers the process's server
 * delegates to. */
export interface RunningServer {
  fetch(req: Request, server: Parameters<typeof handleFetch>[2]): Promise<Response | undefined>;
  /** A message from a browser socket the process registered in `clients`. */
  message(ws: WebSocketLike, message: string | Buffer): void;
  /** Stops serving the process's sessions and closes the load's node hub and listener at once, then
   * resolves once its deliveries in flight have settled. */
  stop(): Promise<void>;
}

/**
 * Starts a handler load. The previous load must have stopped (its `stop` resolved): only one listener
 * binds the socket, and recovering interrupted deliveries while the previous load's dispatcher still
 * settled one could put a second command of its session in flight.
 */
export async function start({ db, clients, sessions, frontendDir, nodeSocket }: ServerProcess): Promise<RunningServer> {
  setDb(db);
  prepareDatabase(db);
  // REINS_NODE_BUNDLE_TEST_HOOKS is a TEST HOOK ONLY: process tests serve a bundle with the node's test
  // hooks (REINS_NODE_TEST_FAUX_PROVIDER). Never set it in production.
  const bundle = buildNodeBundle({ testHooks: process.env.REINS_NODE_BUNDLE_TEST_HOOKS === "1" });
  const state = createServerState(clients, frontendDir, serveNodeBundle(bundle, { bunVersion: Bun.version }), { sessions });
  state.nodes.start();
  const listener = await listenLocalNodeSocket(nodeSocket, socket => state.nodes.accept(socket))
    .catch(async (error: unknown) => { await state.nodes.close(); throw error; });
  const services = loadServices(state);
  const release = sessions.serve(services);
  return {
    fetch: (req, server) => handleFetch(state, req, server),
    message: (ws, message) => handleWsMessage(state, ws, message),
    async stop() {
      release();
      services.stop();
      const settled = state.nodes.close();
      listener.stop();
      state.nodeLinks.close();
      await settled;
    },
  };
}
