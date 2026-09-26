import type { ModelsStore } from "@earendil-works/pi-ai";
import {
  createPiContext as createNodePiContext,
  createPiModelRuntime as createNodePiModelRuntime,
  createPiResources,
  registerPiProvider,
  unregisterPiProvider,
  type PiResourceOptions,
} from "@reins/node/runtime";
import { createDbCredentialStore } from "./credential-store.js";

export { createPiResources, registerPiProvider, unregisterPiProvider };

/** Product credential policy adapter; node runtime construction never opens product SQLite itself. */
export function createPiModelRuntime(options?: {
  allowModelNetwork?: boolean;
  catalogBaseUrl?: string;
  modelsStore?: ModelsStore;
}) {
  return createNodePiModelRuntime({ credentials: createDbCredentialStore(), ...options });
}

export function createPiContext(params: PiResourceOptions & { allowModelNetwork?: boolean }) {
  return createNodePiContext({ ...params, credentials: createDbCredentialStore() });
}
