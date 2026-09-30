/**
 * Handler module entrypoint loaded by the process owner (`server-process.ts`), bundled for dev hot
 * reload. Imports handler and ws so all transitive src/ deps share one scope; `setDb` lets the process
 * owner inject its database handle into that scope.
 */
import * as routes from "./handler.js";
import * as ws from "./ws.js";
import { setDb } from "./db.js";

import { nodeServerServices } from "./runtimes/node-services.js";

export { routes, ws, setDb, nodeServerServices };
