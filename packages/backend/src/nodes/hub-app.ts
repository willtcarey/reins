/**
 * What the process's node hub asks of the current app (`HubApp`, `App.hub`; ADR-029): app code, which
 * hot reloads, unlike the hub. Each answer is the app's: a node's key and whether it may connect (its
 * row), which build it must run (this app's node bundle, ADR-025), and telling browsers (`Nodes.publish`).
 */
import type { AppState, HubApp } from "../state.js";
import { logger } from "../logger.js";
import { NodeNotFoundError } from "../models/nodes.js";
import { NodeRemovedError, NodeRevokedError } from "../models/node.js";
import { Models } from "../models/models.js";

/** How long a node bundle's hello waits for this app's node build (it builds in the background as the app
 * starts) before failing, to be retried: well under the hello timeout. */
export const HELLO_BUILD_WAIT_MS = 5_000;

export interface HubAppOptions {
  /** `HELLO_BUILD_WAIT_MS` by default. */
  buildWaitMs?: number;
}

/** This app's answers to the hub, from `state`. */
export function createHubApp(state: AppState, { buildWaitMs = HELLO_BUILD_WAIT_MS }: HubAppOptions = {}): HubApp {
  const nodes = () => new Models(state).nodes;
  return {
    publicKey(nodeId) {
      try {
        return nodes().get(nodeId).publicKey;
      } catch (error) {
        if (error instanceof NodeNotFoundError) return null;
        throw error;
      }
    },
    refusal(nodeId) {
      try {
        nodes().get(nodeId).assertMayConnect();
        return null;
      } catch (error) {
        if (error instanceof NodeNotFoundError || error instanceof NodeRemovedError || error instanceof NodeRevokedError) return error.message;
        throw error;
      }
    },
    /** One announcing another build than this app's is told to update to this app's; one announcing this
     * app's build negotiates. While the build is still running the hello waits for it, at most
     * `buildWaitMs`, then fails (the node redials). Without a build (it failed) the node is served as it is. */
    async helloBuild(nodeId, buildId) {
      const build = await state.nodeBundle.build(buildWaitMs);
      if (build === "building") return { kind: "not_ready", message: "The server's node build is not ready yet" };
      if (!build) {
        logger.warn(`Node ${nodeId} runs build ${buildId.slice(0, 12)}, and this server has no node build to offer (its build failed); serving it as it is`);
        return { kind: "serve", status: "outdated" };
      }
      if (build.buildId === buildId) return { kind: "serve", status: "current" };
      logger.info(`Node ${nodeId} runs build ${buildId.slice(0, 12)}; telling it to update to ${build.buildId.slice(0, 12)}`);
      return { kind: "update", update: { buildId: build.buildId, sha256: build.sha256, bunVersion: build.bunVersion } };
    },
    publish(nodeId) { nodes().publish(nodeId); },
  };
}
