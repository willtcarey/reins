/**
 * An extension's processes on nodes (`reins.nodes.spawn`, `processes`, `stop`; server-sdk.md *Nodes*; ADR-039),
 * over the app's `Processes` (`models/processes.ts`) as the owner `extension:<name>`: its processes without a key
 * are stopped when it is unloaded, its keyed ones let go then, and stopped once it is not loaded.
 */

import type { ProcessInfo, ProcessOptions } from "@reins/sdk/server";
import type { NodeProcess, NodeProcessExit } from "../nodes/node-process.js";
import type { Processes } from "../models/processes.js";
import { checkSpawn, namedNode } from "../sdk-host/nodes.js";
import type { CallContext } from "../sdk-host/declaration.js";

const PREFIX = "extension:";
export const extensionOwner = (extension: string) => `${PREFIX}${extension}`;

/** One extension's processes, for as long as it is loaded (`ExtensionHost.connect`). */
export interface ExtensionProcessScope {
  spawn(node: string, command: string | readonly string[], options?: ProcessOptions): Promise<NodeProcess>;
  processes(): Promise<ProcessInfo[]>;
  stop(node: string, key: string): Promise<NodeProcessExit | null>;
  /** Lets go of its keyed processes (they run on, recorded), before its own code runs again. */
  detach(): void;
  /** It is unloaded: its processes without a key are stopped, its keyed ones let go. */
  unload(): Promise<void>;
}

export function extensionProcesses(processes: () => Processes, extension: string, context: () => CallContext): ExtensionProcessScope {
  const owner = extensionOwner(extension);
  let unloaded = false;
  const refused = () => new Error(`Extension ${extension} is unloading: it starts no process`);
  return {
    spawn: async (node, command, options) => {
      if (unloaded) throw refused();
      const request = checkSpawn(command, options);
      const handle = await processes().spawn(owner, namedNode(context(), node), request);
      // Started as it unloaded: let go of, or stopped, at once.
      if (unloaded) {
        if (handle.key === null) void handle.stop(); else processes().detach(owner);
        throw refused();
      }
      return handle;
    },
    processes: async () => processes().list(owner),
    stop: async (node, key) => {
      if (typeof key !== "string") throw new Error("A process's key is a string");
      return processes().stop(owner, namedNode(context(), node), key);
    },
    detach: () => {
      unloaded = true;
      processes().detach(owner);
    },
    unload: async () => {
      unloaded = true;
      await processes().unload(owner);
    },
  };
}

/** Stops the kept processes of extensions not `running` (turned off, removed, or their code did not load);
 * with `only`, of that extension alone. */
export function stopProcessesOfStoppedExtensions(processes: Processes, running: (extension: string) => boolean, only?: string): Promise<void> {
  const gone = (owner: string) => owner.startsWith(PREFIX) && !running(owner.slice(PREFIX.length));
  return processes.stopOwners(gone, only === undefined ? undefined : extensionOwner(only));
}
