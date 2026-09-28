import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { LOCAL_MAX_FRAME_BYTES, MAX_UNIX_SOCKET_PATH_BYTES, ndjsonSocketHandler, type NdjsonSocket } from "@reins/node-protocol";

export interface LocalNodeListener {
  readonly path: string;
  /** Stops accepting, closes every connection and removes the socket file. */
  stop(): void;
}

/** Throws unless `dir` is a directory owned by this user that no one else can write, since whoever can
 * write it could replace the socket. */
function checkPrivateDirectory(dir: string): void {
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new Error(`Node socket directory is not a directory: ${dir}`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`Node socket directory is not owned by this user: ${dir}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`Node socket directory is writable by other users: ${dir}`);
}

/** Removes a socket file left by a server that exited without cleanup. A socket something still accepts
 * on is another live server: fail rather than steal its endpoint. Anything that is not a socket is never
 * removed. */
async function clearStaleSocket(path: string): Promise<void> {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (!stat.isSocket()) throw new Error(`Node socket path exists and is not a socket: ${path}`);
  let live = false;
  try {
    const probe = await Bun.connect({ unix: path, socket: { data() {} } });
    live = true;
    probe.end();
  } catch { /* nothing accepts: stale */ }
  if (live) throw new Error(`Another process is already listening on the node socket: ${path}`);
  unlinkSync(path);
}

/**
 * Listens for local node connections on a Unix domain stream socket carrying NDJSON JSON-RPC frames.
 * Local authentication is file permissions: the directory is created 0700 (and an existing one must be
 * private), the socket file is made 0600 right after it is created, and only this user can connect.
 * Remote nodes never use this endpoint: they need enrollment and authenticated TLS instead.
 * Separate from the browser HTTP/WebSocket server.
 */
export async function listenLocalNodeSocket(path: string, accept: (socket: NdjsonSocket) => void, { maxFrameBytes = LOCAL_MAX_FRAME_BYTES }: { maxFrameBytes?: number } = {}): Promise<LocalNodeListener> {
  if (!isAbsolute(path)) throw new Error(`Node socket path must be absolute: ${path}`);
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES) throw new Error(`Node socket path is longer than ${MAX_UNIX_SOCKET_PATH_BYTES} bytes: ${path}`);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkPrivateDirectory(dir);
  await clearStaleSocket(path);
  const listener = Bun.listen({ unix: path, socket: ndjsonSocketHandler(maxFrameBytes, accept) });
  // Bun creates the file per umask; the private directory already keeps others out meanwhile.
  chmodSync(path, 0o600);
  const { ino } = lstatSync(path);
  let stopped = false;
  return {
    path,
    stop() {
      if (stopped) return;
      stopped = true;
      listener.stop(true);
      // Only our own socket: a later server may already have replaced a file we lost.
      try { if (lstatSync(path).ino === ino) unlinkSync(path); } catch { /* already gone */ }
    },
  };
}
