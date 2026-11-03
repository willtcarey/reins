/**
 * The server SDK's `reins.nodes` (docs/dev/server-sdk.md *Nodes*): an adapter over the `Nodes` model and its
 * `NodeHost`, as scripting's `api.nodes.run` is. An extension has no session, so it has no "current" node.
 */

import type { Nodes } from "@reins/sdk/server";
import type { AppState } from "../state.js";
import { Models } from "../models/models.js";
import { MAX_SCRIPT_BYTES } from "../scripting/nodes.js";

/** Longer than a script's 30 s: an extension's service waits for it without holding up an agent. */
export const MAX_EXTENSION_RUN_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function extensionNodes(state: AppState): Nodes {
  return {
    async run(node, command, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
      if (typeof command !== "string" || !command.trim()) throw new Error("A command must not be blank");
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXTENSION_RUN_TIMEOUT_MS) {
        throw new Error(`timeoutMs must be from 1 to ${MAX_EXTENSION_RUN_TIMEOUT_MS}`);
      }
      const host = new Models(state).nodes.find(node).host();
      return host.run(command, { ...(cwd === undefined ? {} : { cwd }), timeoutMs, maxBytes: MAX_SCRIPT_BYTES, ...(signal ? { signal } : {}) });
    },
  };
}
