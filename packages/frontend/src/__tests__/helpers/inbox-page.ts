/**
 * An example extension with a page in the main area, as a notifications inbox (Spoke) would have: only in tests,
 * as no built-in extension needs a page yet.
 */

import type { Disposer, ReinsSdk } from "@reins/sdk";

/** The inbox of a repository; `filter` only changes what the page lists, so it is not part of its identity. */
export type InboxView = { view: "test-inbox"; repository: string; filter?: "unread" | "all"; projectId?: number };

declare module "@reins/sdk" {
  interface ViewTypes {
    "test-inbox": InboxView;
  }
}

/**
 * Registers the inbox page; `events` records its lifecycle. It is about the project of the repository it shows.
 * With `toolbar`, it draws its filter in the host's toolbar.
 */
export function registerInboxPage(reins: Pick<ReinsSdk, "views">, { toolbar = false } = {}): { dispose: Disposer; events: unknown[] } {
  const events: unknown[] = [];
  const dispose = reins.views.register("test-inbox", {
    key: (view) => view.repository,
    pane: {
      title: (view) => `Inbox · ${view.repository}`,
      description: (view) => `Notifications of ${view.repository}`,
      icon: { mount: () => {} },
      ...(toolbar ? { toolbar: { mount: (target: HTMLElement) => { target.append(target.ownerDocument.createElement("select")); } } } : {}),
      mount(target, view) {
        let shown = view;
        events.push(["mount", view]);
        const list = target.ownerDocument.createElement("div");
        target.append(list);
        return {
          update: (next) => { shown = next; events.push(["update", next]); },
          dispose: () => events.push(["dispose"]),
          subject: () => (shown.projectId == null ? [] : [{ type: "project", id: shown.projectId }]),
        };
      },
    },
  });
  return { dispose, events };
}
