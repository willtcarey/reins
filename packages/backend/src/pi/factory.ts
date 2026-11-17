import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore, ModelsStore, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The server's own Pi model context, built directly from Pi with the server's credential store: the
 * model catalog (listing and validating models, OAuth provider metadata) and the model runtime of every
 * session, all of which run on the server (ADR-029, `session-runtime/`). Credentials and model
 * configuration never leave the server's machine.
 */

const additionalProviders = new Map<string, Provider>();

/** Adds a provider to every model runtime the server builds from now on (tests register faux providers). */
export function registerPiProvider(provider: Provider): void { additionalProviders.set(provider.id, provider); }
export function unregisterPiProvider(providerId: string): void { additionalProviders.delete(providerId); }

let piConfigDir: string | null = null;

/**
 * Makes `<dataDir>/pi` the place of Pi's model files for the runtimes built from now on: `models.json`
 * (custom providers and model settings) and `models-store.json` (pi.dev's catalogs, which Pi keeps beside
 * it). Not Pi's own `~/.pi/agent`, which the user's `pi` CLI writes its version's catalog to. `null`: none
 * (tests), so runtimes read no `models.json` and keep catalogs in memory.
 */
export function setUpPiConfigDir(dataDir: string | null): void {
  if (dataDir === null) {
    piConfigDir = null;
    return;
  }
  piConfigDir = join(dataDir, "pi");
  mkdirSync(piConfigDir, { recursive: true, mode: 0o700 });
}

/** Pi's model runtime over the server's stored credentials (`credentials`: `DbCredentialStore`, under the
 * process's lock; `Models.credentials`). Offline catalog unless `allowModelNetwork`. */
export async function createPiModelRuntime(options: {
  allowModelNetwork?: boolean;
  catalogBaseUrl?: string;
  modelsStore?: ModelsStore;
  credentials: CredentialStore;
}): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    credentials: options.credentials,
    allowModelNetwork: options.allowModelNetwork ?? false,
    modelsPath: piConfigDir === null ? null : join(piConfigDir, "models.json"),
    modelRefreshTimeoutMs: 3_000,
    catalogBaseUrl: options.catalogBaseUrl,
    modelsStore: options.modelsStore,
  });
  for (const provider of additionalProviders.values()) modelRuntime.registerNativeProvider(provider);
  return modelRuntime;
}
