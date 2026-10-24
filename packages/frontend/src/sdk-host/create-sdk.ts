/**
 * Builds the Reins SDK (`@reins/sdk`) over the app's state (docs/dev/reins-sdk.md). app-shell builds one and gives
 * it to the built-ins' register functions; nothing else holds it.
 */

import type { Commands, ContainerId, Files, Messages, OpenOptions, ReinsSdk, Sessions, View, Views } from "@reins/sdk";

/** What the SDK is built over: `AppStore` in the app, its parts in tests. */
export interface SdkBacking {
  readonly files: Files;
  readonly views: Views;
  readonly decorators: Messages;
  readonly commands: Commands;
  open(view: View, container: ContainerId): void;
}

/** `sessions` is apart from the app's state because it also navigates (`SessionActions` in the app). */
export function createReinsSdk(app: SdkBacking, sessions: Sessions): ReinsSdk {
  return Object.freeze({
    files: app.files,
    workspace: Object.freeze({ open: (view: View, { in: container = "inspector" }: OpenOptions = {}) => app.open(view, container) }),
    views: Object.freeze({ register: app.views.register.bind(app.views) }),
    messages: Object.freeze({ registerDecorator: app.decorators.registerDecorator.bind(app.decorators) }),
    commands: Object.freeze({ register: app.commands.register.bind(app.commands) }),
    sessions: Object.freeze({
      get: sessions.get.bind(sessions),
      create: sessions.create.bind(sessions),
      open: sessions.open.bind(sessions),
      compact: sessions.compact.bind(sessions),
    }),
  });
}
