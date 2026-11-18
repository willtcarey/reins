/**
 * The `onSettled` hooks (`reins.sessions.onSettled`, docs/dev/server-sdk.md *Sessions*), as the current app runs
 * them when a run ends (`App.sessionSettled`): the hooks of the extension that started the session only.
 */
import type { AppState, SessionSettledNotice } from "../../state.js";
import { logger } from "../../logger.js";
import { coreSessionHooks } from "./core.js";

/** Not awaited: a hook's failure is its extension's error, never the settlement's. */
export function runOnSettled(state: AppState, { extension, ...settlement }: SessionSettledNotice): void {
  const report = (name: string | null, error: unknown) => {
    if (name === null) logger.error("Reins' own onSettled hook failed:", error);
    else state.extensions.reportError(name, error);
  };
  const hooks = [
    ...coreSessionHooks(state.process).onSettled.map(hook => ({ extension: null, hook })),
    ...state.extensions.host.sessionHooks.list("onSettled").filter(entry => entry.extension === extension),
  ];
  for (const entry of hooks) {
    try {
      void Promise.resolve(entry.hook(settlement)).catch((error: unknown) => report(entry.extension, error));
    } catch (error) {
      report(entry.extension, error);
    }
  }
}
