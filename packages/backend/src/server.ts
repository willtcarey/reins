/**
 * Server module entrypoint used by dev hot-reload bundling.
 * Re-exports handler and ws so all transitive src/ deps share one scope.
 */
export * as routes from "./handler.js";
export * as ws from "./ws.js";
