/**
 * The secrets extension (docs/features/secrets.md): an agent asks for credentials, the user enters them in a masked
 * form in the session, and the session gets a handle for each value, never the value. It uses only the server SDK
 * (`@reins/sdk/server`) and its own modules.
 */

import { setTimeout as sleep } from "timers/promises";
import type { Disposer, HttpHandlers, ServerExtension, ServerSdk } from "@reins/sdk/server";
import { secretsApi, type SecretsApi } from "./api.js";
import { secretsMigrations } from "./migrations.js";
import { secretsPromptSection } from "./prompt.js";
import { secretsScripting } from "./scripting.js";
import { Secrets, SecretsError } from "./secrets.js";

export interface SecretsOptions {
  /** The clock: tests give a fake one. */
  now?: () => Date;
  /** How long the expiry service waits between sweeps. */
  sweepMs?: number;
}

const SWEEP_MS = 10 * 60 * 1000;

/** A refusal as the HTTP host answers it: its status and message. */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SecretsError) throw Object.assign(new Error(error.message), { status: error.status });
    throw error;
  }
}

export function startSecrets(reins: ServerSdk, { now = () => new Date(), sweepMs = SWEEP_MS }: SecretsOptions = {}): { extension: Secrets; dispose: Disposer } {
  const extension = new Secrets({ db: reins.db, secrets: reins.secrets, sessions: reins.sessions, broadcast: reins.broadcast, logger: reins.logger, now });
  const handlers: HttpHandlers<SecretsApi> = {
    requests: async () => extension.open(),
    submit: ({ input }) => answering(() => extension.submit(input.id, input.values)),
    cancel: ({ input }) => answering(() => extension.cancel(input.id)),
    stored: async () => extension.stored(),
    remove: ({ input }) => answering(() => extension.remove(input.id)),
  };
  const removals = [
    reins.scripting.register(secretsScripting(extension)),
    reins.prompt.register(secretsPromptSection),
    reins.http.handle(secretsApi, handlers),
    reins.services.register({
      name: "expiry",
      start: ({ signal, fail }) => {
        void (async () => {
          while (!signal.aborted) {
            await extension.expire();
            await sleep(sweepMs, undefined, { signal });
          }
        })().catch(fail);
      },
    }),
  ];
  return {
    extension,
    async dispose() {
      for (const remove of removals) await remove();
    },
  };
}

export const secrets: ServerExtension = {
  migrations: secretsMigrations,
  register: reins => startSecrets(reins).dispose,
};
