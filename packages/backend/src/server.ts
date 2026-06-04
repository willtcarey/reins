/**
 * Server module entrypoint used by dev hot-reload bundling.
 * Imports handler and ws so all transitive src/ deps share one scope.
 */
import * as routes from "./handler.js";
import * as ws from "./ws.js";

export { routes, ws };
