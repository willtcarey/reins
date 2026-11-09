/**
 * The secrets extension's frontend part (docs/features/secrets.md): the form a session's request for secrets is
 * answered in, opened in the Inspector when the user goes to that session, and a Settings page of what is stored.
 * Its backend part keeps the requests; this part reads them again when it says they changed and on reconnect, so a
 * reloaded page and every other browser follow.
 */

import type { Disposer, ReinsSdk } from "@reins/sdk";
import type { SecretsApi } from "@backend/extensions/secrets/api.js";
import { lockIcon, paneIcon } from "../../ui/icons.js";
import type { SecretsRequest, SecretsRequestForm } from "./request-form.js";
import "./request-form.js";
import "./settings-section.js";

type SecretsSdk = ReinsSdk<SecretsApi>;

export type SecretsRequestView = { view: "secrets-request"; requestId: string };

declare module "@reins/sdk" {
  interface ViewTypes {
    "secrets-request": SecretsRequestView;
  }
}

/** The open requests, as the backend part last answered. */
class OpenRequests {
  requests: readonly SecretsRequest[] = [];
  private listeners = new Set<() => void>();
  private latest = 0;

  constructor(private readonly reins: SecretsSdk) {}

  async load(): Promise<void> {
    const asked = ++this.latest;
    try {
      const requests = await this.reins.http.call("requests");
      if (asked !== this.latest) return;
      this.requests = requests;
      for (const listener of this.listeners) listener();
    } catch (error) {
      console.error("Could not load the requests for secrets", error);
    }
  }

  find(id: string): SecretsRequest | null {
    return this.requests.find(request => request.id === id) ?? null;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function registerSecrets(reins: SecretsSdk): Disposer {
  const open = new OpenRequests(reins);
  /** The requests this browser opened the form of: each opens by itself once, then from the Inspector. */
  const opened = new Set<string>();
  const openShown = () => {
    const sessionId = reins.workspace.currentSubject("session");
    for (const request of open.requests) {
      if (request.sessionId !== sessionId || opened.has(request.id)) continue;
      opened.add(request.id);
      reins.workspace.open({ view: "secrets-request", requestId: request.id }, { in: "inspector" });
    }
  };
  /** The requests open at the last load, so one that ended (answered here or in another browser) has its tab closed. */
  let known = new Set<string>();
  const close = (requestId: string) => reins.workspace.close({ view: "secrets-request", requestId });
  const closeEnded = () => {
    const now = new Set(open.requests.map(request => request.id));
    for (const id of known) if (!now.has(id)) close(id);
    known = now;
  };
  const disposers: Disposer[] = [
    open.subscribe(closeEnded),
    open.subscribe(openShown),
    reins.workspace.onDidChange(openShown),
    reins.onMessage(() => void open.load()),
    reins.onReconnect(() => void open.load()),
    reins.views.register("secrets-request", {
      key: view => view.requestId,
      pane: {
        title: () => "Secrets",
        description: () => "Enter the secrets this session asked for",
        icon: paneIcon(lockIcon),
        width: 360,
        mount(target, view) {
          const form: SecretsRequestForm = target.ownerDocument.createElement("secrets-request-form");
          const show = () => { form.request = open.find(view.requestId); };
          show();
          form.submit = async values => { await reins.http.call("submit", { id: view.requestId, values }); close(view.requestId); };
          form.cancel = async () => { await reins.http.call("cancel", { id: view.requestId }); close(view.requestId); };
          const stop = open.subscribe(show);
          target.append(form);
          return { dispose() { stop(); form.remove(); } };
        },
      },
    }),
    reins.settings.register({
      mount(target) {
        const section = target.ownerDocument.createElement("settings-secrets-section");
        section.reins = reins;
        target.append(section);
        return { dispose: () => section.remove() };
      },
    }),
  ];
  void open.load();
  return () => {
    for (const dispose of disposers) dispose();
  };
}
