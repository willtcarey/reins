/**
 * The handler module: what the process owner (`server-process.ts`) loads and swaps on every reload. In
 * dev it is bundled from this entry, so every source it reaches shares one module scope per load.
 *
 * `start` serves one load: it opens the database (migrations, then recovery of interrupted outbox
 * deliveries), builds the load's state (a new node hub) and listens on the node socket. `stop` closes the
 * hub and listener (the node's connection drops and it redials whichever load listens next), waits for
 * the deliveries in flight to settle and closes the database (docs/dev/hot-reload.md).
 */
import type { WebSocketLike, WsClient } from "./state.js";
import { handleFetch } from "./handler.js";
import { handleWsMessage } from "./ws.js";
import { openDb, setDb } from "./db.js";
import { createServerState } from "./state.js";
import { listenLocalNodeSocket } from "./nodes/local-socket.js";

/** What the process owner keeps across loads and hands each one. */
export interface ServerProcess {
  /** Browser clients, which outlive a reload: the process registers each socket (the HTTP server is the
   * process's). */
  clients: Set<WsClient>;
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
  /** Closes the load's node hub and listener at once, then resolves once its deliveries in flight have
   * settled and its database is closed. */
  stop(): Promise<void>;
}

/**
 * Starts a handler load. The previous load must have stopped (its `stop` resolved): only one listener
 * binds the socket, and recovering interrupted deliveries while the previous load's dispatcher still
 * settled one could put a second command of its session in flight.
 */
export async function start({ clients, frontendDir, nodeSocket }: ServerProcess): Promise<RunningServer> {
  const db = openDb();
  setDb(db);
  const state = createServerState(clients, frontendDir);
  state.nodes.start();
  const listener = await listenLocalNodeSocket(nodeSocket, socket => state.nodes.accept(socket))
    .catch(async (error: unknown) => { await state.nodes.close(); db.close(); throw error; });
  return {
    fetch: (req, server) => handleFetch(state, req, server),
    message: (ws, message) => handleWsMessage(state, ws, message),
    async stop() {
      const settled = state.nodes.close();
      listener.stop();
      await settled;
      db.close();
    },
  };
}
