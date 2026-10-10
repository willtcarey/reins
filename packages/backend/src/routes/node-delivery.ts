/**
 * Node Delivery Routes
 *
 * What a remote machine installs and updates a node from, under `/nodes` (`node-bundle/delivery.ts`):
 * the install script, the manifest of the current build and that build's bundle.
 */

import type { RouterGroup } from "../router.js";

export function registerNodeDeliveryRoutes(router: RouterGroup) {
  router.get("/install", ({ req, state }) => state.nodeBundle.installScript(req));
  router.get("/manifest", ({ state }) => state.nodeBundle.manifest());
  router.get("/builds/:buildId/reins.js", ({ params, state }) => state.nodeBundle.bundle(params.buildId!));
}
