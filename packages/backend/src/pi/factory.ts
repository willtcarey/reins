import type { CredentialStore, ModelsStore, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDbCredentialStore } from "./credential-store.js";

/**
 * The server's own Pi model context, built directly from Pi with the server's credential store: the
 * model catalog (listing and validating models, OAuth provider metadata), credential refreshes for nodes,
 * and the model runtime of sessions running on the server (ADR-029, `session-runtime/`). Nothing here
 * comes from the node package.
 */

const additionalProviders = new Map<string, Provider>();

/** Adds a provider to every model runtime the server builds from now on (tests register faux providers). */
export function registerPiProvider(provider: Provider): void { additionalProviders.set(provider.id, provider); }
export function unregisterPiProvider(providerId: string): void { additionalProviders.delete(providerId); }

/** Pi's model runtime over the server's stored credentials (`credentials`, by default this load's
 * `DbCredentialStore`). Offline catalog unless `allowModelNetwork`. */
export async function createPiModelRuntime(options: {
  allowModelNetwork?: boolean;
  catalogBaseUrl?: string;
  modelsStore?: ModelsStore;
  credentials?: CredentialStore;
} = {}): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    credentials: options.credentials ?? createDbCredentialStore(),
    allowModelNetwork: options.allowModelNetwork ?? false,
    modelRefreshTimeoutMs: 3_000,
    catalogBaseUrl: options.catalogBaseUrl,
    modelsStore: options.modelsStore,
  });
  for (const provider of additionalProviders.values()) modelRuntime.registerNativeProvider(provider);
  return modelRuntime;
}
