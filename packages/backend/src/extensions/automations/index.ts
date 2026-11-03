/**
 * The automations extension (docs/features/automations.md): wake-ups and heartbeats, a message sent to a
 * session on a schedule. It uses only the server SDK (`@reins/sdk/server`) and its own modules.
 */

import { setTimeout as sleep } from "timers/promises";
import type { Disposer, ServerExtension, ServerSdk } from "@reins/sdk/server";
import { Automations } from "./automations.js";
import { automationsMigrations } from "./migrations.js";
import { registerAutomationsRoutes } from "./routes.js";
import { automationsScripting } from "./scripting.js";

export interface AutomationsOptions {
  /** The clock: tests give a fake one. */
  now?: () => Date;
  /** How long the scheduler waits between ticks. */
  pollMs?: number;
}

const POLL_MS = 30_000;

/** Starts automations for one app: its scheduler service (which ticks at once, so what came due while Reins was
 * down runs at startup), its settlement listener, `api.automations` and its HTTP API. */
export function startAutomations(reins: ServerSdk, { now = () => new Date(), pollMs = POLL_MS }: AutomationsOptions = {}): { automations: Automations; dispose: Disposer } {
  const automations = new Automations({ db: reins.db, sessions: reins.sessions, logger: reins.logger, now });
  const removals = [
    reins.sessions.onSettled(settlement => automations.settled(settlement)),
    reins.scripting.register(automationsScripting(automations, reins.sessions)),
    registerAutomationsRoutes(reins.http, automations),
    reins.services.register({
      name: "scheduler",
      start: ({ signal, fail }) => {
        void (async () => {
          while (!signal.aborted) {
            await automations.tick();
            await sleep(pollMs, undefined, { signal });
          }
        })().catch(fail);
        // A tick in progress ends before the next app's scheduler starts.
        return { stop: () => automations.idle() };
      },
    }),
  ];
  return {
    automations,
    async dispose() {
      for (const remove of removals) await remove();
    },
  };
}

export const automations: ServerExtension = {
  migrations: automationsMigrations,
  register: reins => startAutomations(reins).dispose,
};
