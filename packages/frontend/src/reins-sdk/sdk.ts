/**
 * Builds the Reins SDK over the app's state (docs/dev/reins-sdk.md). app-shell builds one and gives
 * it to the built-ins' register functions; nothing else holds it.
 */

import type { ContainerId, Files, Messages, OpenOptions, ReinsSdk, View, Views } from "./contract.js";

/** What the SDK is built over: `AppStore` in the app, its parts in tests. */
export interface SdkBacking {
  readonly files: Files;
  readonly views: Views;
  readonly decorators: Messages;
  open(view: View, container: ContainerId): void;
}

export function createReinsSdk(app: SdkBacking): ReinsSdk {
  return Object.freeze({
    files: app.files,
    workspace: Object.freeze({ open: (view: View, { in: container = "inspector" }: OpenOptions = {}) => app.open(view, container) }),
    views: Object.freeze({ register: app.views.register.bind(app.views) }),
    messages: Object.freeze({ registerDecorator: app.decorators.registerDecorator.bind(app.decorators) }),
  });
}
