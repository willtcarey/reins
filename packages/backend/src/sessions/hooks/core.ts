/**
 * Reins' own session hooks, on the seam the extensions use: each runs before every extension's hook of its name,
 * and no one turns it off.
 */
import type { ServerProcess } from "../../state.js";
import type { SessionHookTypes } from "./registry.js";
import { checkOutTaskBranch } from "./task-branch.js";

export const coreSessionHooks = (serverProcess: ServerProcess): { [K in keyof SessionHookTypes]: readonly SessionHookTypes[K][] } => ({
  beforeRun: [run => checkOutTaskBranch(serverProcess, run)],
  onSettled: [],
});
