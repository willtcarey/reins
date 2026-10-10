/**
 * BUNDLE ONLY: what Pi needs to run from one bundled file (`reins.js`, docs/dev/node-bundle.md). Pi loads its
 * OAuth flows and its Bedrock provider through computed `import()` paths, which a bundle cannot follow:
 * without this, every request on a stored OAuth credential fails ("Cannot find module './anthropic.js'").
 * Registering them statically is what Pi's own Bun binary does (`pi-coding-agent/dist/bun/runtime-setup.js`).
 * The node run from source keeps loading them lazily: only the bundle's entry imports this module.
 */
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

export function registerBundledPiModules(): void {
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
}
