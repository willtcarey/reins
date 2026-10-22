/**
 * The module behind the `reins-sdk` specifier, from which features import the SDK
 * (docs/dev/reins-sdk.md *Access*). Its capabilities are read from the installed host on each use,
 * so features can import it before app-shell installs the host, but not use it.
 */

import type { ReinsSdk } from "./contract.js";
import { installedSdk } from "./host.js";

export const reins: ReinsSdk = Object.freeze({
  get files() { return installedSdk().files; },
  get workspace() { return installedSdk().workspace; },
  get views() { return installedSdk().views; },
  get messages() { return installedSdk().messages; },
});
