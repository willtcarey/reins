import type { Provider } from "@earendil-works/pi-ai";
import { registerPiProvider as registerNodeProvider, unregisterPiProvider as unregisterNodeProvider } from "@reins/node/runtime";
import { registerPiProvider as registerServerProvider, unregisterPiProvider as unregisterServerProvider } from "../../runtimes/pi/factory.js";

/** Registers a (faux) provider with the server's model runtimes (catalog, validation) and with those of
 * in-process test nodes: the server and the node build their Pi model runtimes independently. */
export function registerPiProvider(provider: Provider): void {
  registerServerProvider(provider);
  registerNodeProvider(provider);
}

export function unregisterPiProvider(providerId: string): void {
  unregisterServerProvider(providerId);
  unregisterNodeProvider(providerId);
}
