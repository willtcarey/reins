/** The automations extension's HTTP API (`automationsApi`, api.ts), over `Automations`. */

import type { Disposer, Http } from "@reins/sdk/server";
import { automationsApi } from "./api.js";
import { AutomationNotFoundError, InvalidAutomationError, type Automations } from "./automations.js";
import { InvalidScheduleError } from "./schedule.js";

/** An error the host answers with its status and `{ error: message }`. */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RouteError";
  }
}

async function translated<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AutomationNotFoundError) throw new RouteError(404, error.message);
    if (error instanceof InvalidScheduleError || error instanceof InvalidAutomationError) throw new RouteError(400, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Session not found")) throw new RouteError(404, message);
    throw error;
  }
}

export function registerAutomationsRoutes(http: Http, automations: Automations): Disposer {
  return http.handle(automationsApi, {
    list: ({ input }) => automations.list(input),
    runs: ({ input }) => translated(() => automations.runs(input.id, input.limit)),
    create: ({ input }) => translated(() => automations.create({ ...input, createdBySessionId: null })),
    cancel: ({ input }) => translated(() => automations.cancel(input.id, "Cancelled by the user")),
    replaceSession: ({ input }) => translated(() => automations.replaceSession(input.id)),
  });
}
