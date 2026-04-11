/**
 * Single dev-mode entrypoint — bundles handler and ws into one output
 * so all transitive src/ deps share a single module scope.
 */
export * as routes from "./handler.js";
export * as ws from "./ws.js";
