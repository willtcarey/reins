/**
 * Extensions Store
 *
 * Settings' Extensions section: each extension, its backend part as the server reports it (`GET
 * /api/extensions`) merged by name with its frontend part as the app activated it (`ExtensionHost`). An extension
 * may have only one part. Each can be turned on or off, and an added one reloaded or removed.
 */

import type { ExtensionSource } from "@backend/extensions-store.js";
import type { ExtensionView } from "@backend/extension-system/report.js";
import type { ExtensionInfo } from "@reins/sdk";
import { Loadable } from "../../helpers/loadable.js";
import type { ExtensionHost, FrontendExtension } from "../../extension-system/host.js";
import { api } from "../api.js";
import type { InboundEventSource } from "../ws-client.js";

export type ExtensionsStoreResult = { ok: true } | { error: string };

/** One extension, both parts. Its label, description and icon are its frontend part's, else an added
 * extension's manifest's, else the app's info on the built-in (one turned off, or with only a backend part). */
export interface ExtensionSummary {
  name: string;
  /** Its frontend label, else its manifest's, else its name. */
  label: string;
  description: string | null;
  icon: ExtensionInfo["icon"];
  /** Where it came from (the backend's report); built in when the report does not have it. */
  source: ExtensionSource;
  /** An added extension's version, from its manifest. */
  version: string | null;
  /** The parts it has running now: none while it is turned off. */
  parts: { backend: boolean; frontend: boolean };
  /** Whether it is on: the user's switch, which the server keeps. */
  enabled: boolean;
  /** `failed` when either part failed; `loading` while an added one is imported; `disabled` while it is off. */
  status: "loaded" | "failed" | "loading" | "disabled";
  /** What stopped each part that failed, as the section shows it. */
  problems: string[];
  backend: ExtensionView | null;
  frontend: FrontendExtension | null;
}

const BACKEND_STAGES: Record<NonNullable<ExtensionView["failure"]>["stage"], string> = {
  manifest: "its manifest is invalid",
  load: "its files could not be loaded",
  storage: "its directory or database could not be opened",
  migration: "a migration failed",
  register: "its register function threw",
};

export class ExtensionsStore {
  backend: Loadable<ExtensionView[]> = Loadable.idle();

  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void>;

  /** `frontend`: the app's activated extensions; none in tests of the backend's part alone. `events`: the
   * server's messages, whose `extensions_changed` loads the report again once it was loaded. `builtIns`: the
   * app's built-in parts, which name an extension turned off. */
  constructor(
    private readonly frontend: Pick<ExtensionHost, "list" | "subscribe"> | null = null,
    events?: InboundEventSource,
    private readonly builtIns: readonly ExtensionInfo[] = [],
  ) {
    this.unsubscribe = [
      frontend?.subscribe(() => this.notify()) ?? (() => {}),
      events?.subscribe({ extensions_changed: () => { if (this.backend.data) void this.load(); } }) ?? (() => {}),
    ];
  }

  /** Loads an added extension's files anew; the server's `extensions_changed` then reloads the report. */
  async reload(name: string): Promise<void> {
    await api.installedExtensions.reload(name);
  }

  /** Unloads an added extension and forgets it (its data stays). */
  async remove(name: string): Promise<void> {
    await api.installedExtensions.remove(name);
  }

  /** Turns an extension on or off, built in or added; the app follows when the server says extensions changed. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await api.installedExtensions.setEnabled(name, enabled);
  }

  get backendError(): string | null {
    return this.backend.error;
  }

  /** Every extension, by label. */
  get extensions(): ExtensionSummary[] {
    const backend = new Map((this.backend.data ?? []).map((view) => [view.name, view]));
    const frontend = new Map((this.frontend?.list() ?? []).map((part) => [part.extension.name, part]));
    const names = new Set([...backend.keys(), ...frontend.keys()]);
    const builtIns = new Map(this.builtIns.map((info) => [info.name, info]));
    return [...names].map((name) => summary(name, backend.get(name) ?? null, frontend.get(name) ?? null, builtIns.get(name) ?? null))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  }

  /** Asks the server for its report again; the frontend's part is always current. */
  async load(): Promise<ExtensionsStoreResult> {
    this.backend = this.backend.asLoading();
    this.notify();
    try {
      this.backend = this.backend.asLoaded(await api.installedExtensions.list());
      return { ok: true };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.backend = this.backend.asError(error);
      return { error };
    } finally {
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function summary(name: string, backend: ExtensionView | null, frontend: FrontendExtension | null, builtIn: ExtensionInfo | null): ExtensionSummary {
  const enabled = backend?.status !== "disabled";
  const problems: string[] = [];
  if (backend?.failure) problems.push(`Backend: ${BACKEND_STAGES[backend.failure.stage]}: ${backend.failure.message}`);
  if (frontend?.error != null) problems.push(`Frontend: its register function threw: ${frontend.error}`);
  else if (backend?.frontendFailure) problems.push(`Frontend: it failed in a browser: ${backend.frontendFailure.message}`);
  return {
    name,
    label: frontend?.extension.label ?? backend?.manifest?.label ?? builtIn?.label ?? name,
    description: frontend?.extension.description ?? backend?.manifest?.description ?? builtIn?.description ?? null,
    icon: frontend?.extension.icon ?? builtIn?.icon,
    source: backend?.source ?? { kind: "built-in" },
    version: backend?.manifest?.version ?? null,
    parts: { backend: enabled && (backend?.backendPart ?? false), frontend: frontend !== null },
    enabled,
    status: !enabled ? "disabled" : problems.length > 0 ? "failed" : backend?.status === "loading" ? "loading" : "loaded",
    problems,
    backend,
    frontend,
  };
}
