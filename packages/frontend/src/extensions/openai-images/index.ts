/**
 * The openai-images extension's frontend part (docs/features/images.md): its Settings page, which lists the
 * image endpoints and lets the user add, test, change and remove them.
 */

import type { OpenAiImagesApi } from "@backend/extensions/openai-images/api.js";
import type { Disposer, ReinsSdk } from "@reins/sdk";
import { EndpointsStore } from "./endpoints-store.js";
import { showToast } from "../../ui/toast.js";
import "./endpoints-section.js";

export function registerOpenAiImages(reins: ReinsSdk<OpenAiImagesApi>): Disposer {
  return reins.settings.register({
    mount(target) {
      const store = new EndpointsStore(reins);
      const section = target.ownerDocument.createElement("settings-openai-images-section");
      section.store = store;
      target.append(section);
      void store.load().then((result) => {
        if ("error" in result) showToast(`Failed to load image endpoints: ${result.error}`, "error");
      });
      return {
        dispose() {
          section.remove();
          store.dispose();
        },
      };
    },
  });
}
