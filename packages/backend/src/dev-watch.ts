/**
 * The dev server's source watcher (`server-process.ts`; docs/dev/hot-reload.md *What triggers what*).
 * Process-owned: a change needs a server restart.
 *
 * Edits are debounced together (`debounceMs`); each debounced run then decides:
 * - A process-owned source's contents changed since this process started (`process-owned.json`'s list, the list
 *   itself included): restart the process, once its new code builds (`checkBuilds` of the process's entry,
 *   which reaches the app too). A build error is logged and the running process kept, reloading nothing
 *   until an edit that builds. Without a supervisor to restart it (no `restart`), only a warning, and app
 *   edits reload as usual.
 * - Else an app source (a `.ts` under `src/`) or a reloadable workspace package's changed: reload the app.
 * - `@reins/node-protocol`: only a warning, since the server and node must restart together. A
 *   process-owned change after a protocol change is warned about instead of restarting this process
 *   alone, which would start it on the new protocol while the node keeps the old one.
 *
 * Bun's `fs.watch` may report only the first of several files written at once, so which sources changed
 * is decided by their contents, not by the events' file names: saving a file unchanged restarts nothing.
 */
import { readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { checkBuilds } from "./dev-build.js";
import { logger } from "./logger.js";

type Log = (message: string, ...rest: unknown[]) => void;

export interface DevWatchOptions {
  /** `packages/backend/src`: the process's and the app's sources. */
  srcDir: string;
  /** The process-owned sources, relative to `srcDir`. */
  processOwned: ReadonlySet<string>;
  /** The process's entry (absolute), built to check the new code before a restart. */
  processEntry: string;
  /** Reloadable workspace packages: an edit to their sources reloads the app. */
  packages: ReadonlyArray<{ name: string; dir: string }>;
  protocol: { name: string; dir: string };
  reload(what: string): Promise<void>;
  /** Exits for the supervisor to start this process again; absent when nothing would. */
  restart?: (what: string) => void;
  log?: { info: Log; warn: Log; error: Log };
  debounceMs?: number;
}

export interface DevWatcher {
  /** Reloads the app as a source edit would (debounced with edits). */
  reload(what: string): void;
  close(): void;
}

const RELOAD = "\x1b[36m[hot reload]\x1b[0m";
const FAILED = "\x1b[31m[hot reload]\x1b[0m";
const WARNING = "\x1b[33m[hot reload]\x1b[0m";

const isSource = (filename: string | null): filename is string =>
  !!filename && filename.endsWith(".ts") && !filename.endsWith(".test.ts") && !/(^|\/)__\w+__\//.test(filename);

/** A hash of each file's contents (`missing` once removed), to tell which changed. */
function snapshot(dir: string, files: Iterable<string>): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const file of files) {
    try {
      stamps.set(file, String(Bun.hash(readFileSync(join(dir, file)))));
    } catch {
      stamps.set(file, "missing");
    }
  }
  return stamps;
}

function changedSince(dir: string, before: Map<string, string>, files: Iterable<string> = before.keys()): string[] {
  const now = snapshot(dir, files);
  return [...now].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file);
}

const protocolSources = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(file => isSource(file));

export function watchDevSources(options: DevWatchOptions): DevWatcher {
  const { srcDir, processOwned, processEntry, protocol, restart, log = logger, debounceMs = 100 } = options;
  // What this process runs: process-owned code and the protocol as they were when it started.
  const started = snapshot(srcDir, processOwned);
  const protocolStarted = snapshot(protocol.dir, protocolSources(protocol.dir));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The app reload the next run makes, unless it restarts the process instead. */
  let reloading: string | undefined;

  const schedule = (reload?: string): void => {
    if (reload) reloading = reload;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), debounceMs);
  };

  const run = async (): Promise<void> => {
    const reload = reloading;
    reloading = undefined;
    const owned = restart ? changedSince(srcDir, started) : [];
    if (owned.length > 0) {
      const what = `${owned.join(", ")} changed`;
      const protocolChanged = changedSince(protocol.dir, protocolStarted, new Set([...protocolStarted.keys(), ...protocolSources(protocol.dir)]));
      if (protocolChanged.length === 0) {
        try {
          await checkBuilds(processEntry);
        } catch (error) {
          log.error(`${FAILED} ${what}: process-owned code changed, but the new code does not build; the server keeps running:`, error);
          return;
        }
        log.info(`${RELOAD} ${what}: process-owned code changed; restarting the server`);
        restart!(what);
        return;
      }
      log.warn(`${WARNING} ${what}: process-owned code changed, but so did ${protocol.name} since this server started; restart \`bun run dev\` to apply both`);
    }
    if (!reload) return;
    try {
      await options.reload(reload);
      log.info(`${RELOAD} ${reload}`);
    } catch (error) {
      log.error(`${FAILED} Failed to reload:`, error);
    }
  };

  const watchers = [
    watch(srcDir, { recursive: true }, (_event, filename) => {
      if (filename && processOwned.has(filename)) {
        if (restart) schedule();
        else log.warn(`${WARNING} ${filename}: process-owned code changed; restart the server to apply it`);
        return;
      }
      if (isSource(filename)) schedule(`${filename} reloaded`);
    }),
    ...options.packages.map(({ name, dir }) => watch(dir, { recursive: true }, (_event, filename) => {
      if (isSource(filename)) schedule(`${name} ${filename} reloaded`);
    })),
    watch(protocol.dir, { recursive: true }, (_event, filename) => {
      if (isSource(filename)) log.warn(`${WARNING} ${protocol.name} ${filename}: protocol code changed; restart the server and node together (\`bun run dev\`)`);
    }),
  ];

  return {
    reload: what => schedule(what),
    close() {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
