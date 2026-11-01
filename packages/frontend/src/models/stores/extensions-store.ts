/**
 * Extensions Store
 *
 * Settings' Extensions section: each extension, its backend part as the server reports it (`GET
 * /api/extensions`) merged by name with its frontend part as the app activated it (`Extensions`). An extension
 * may have only one part. Read-only: there is no switch yet.
 */

import type { ExtensionView } from "@backend/extensions/host.js";
import type { ExtensionInfo } from "@reins/sdk";
import { Loadable } from "../../helpers/loadable.js";
import type { Extensions, FrontendExtension } from "../../sdk-host/extensions.js";
import { api } from "../api.js";

export type ExtensionsStoreResult = { ok: true } | { error: string };

/** One extension, both parts. Its label, description and icon are its frontend part's: the backend has none. */
export interface ExtensionSummary {
  name: string;
  /** Its frontend label, else its name. */
  label: string;
  description: string | null;
  icon: ExtensionInfo["icon"];
  parts: { backend: boolean; frontend: boolean };
  /** `failed` when either part failed. */
  status: "loaded" | "failed";
  /** What stopped each part that failed, as the section shows it. */
  problems: string[];
  backend: ExtensionView | null;
  frontend: FrontendExtension | null;
}

const BACKEND_STAGES: Record<NonNullable<ExtensionView["failure"]>["stage"], string> = {
  storage: "its directory or database could not be opened",
  migration: "a migration failed",
  register: "its register function threw",
};

export class ExtensionsStore {
  backend: Loadable<ExtensionView[]> = Loadable.idle();

  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  /** `frontend`: the app's activated extensions; none in tests of the backend's part alone. */
  constructor(private readonly frontend: Pick<Extensions, "list" | "subscribe"> | null = null) {
    this.unsubscribe = frontend?.subscribe(() => this.notify()) ?? (() => {});
  }

  get backendError(): string | null {
    return this.backend.error;
  }

  /** Every extension, by label. */
  get extensions(): ExtensionSummary[] {
    const backend = new Map((this.backend.data ?? []).map((view) => [view.name, view]));
    const frontend = new Map((this.frontend?.list() ?? []).map((part) => [part.extension.name, part]));
    const names = new Set([...backend.keys(), ...frontend.keys()]);
    return [...names].map((name) => summary(name, backend.get(name) ?? null, frontend.get(name) ?? null))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  }

  /** Asks the server for its report again; the frontend's part is always current. */
  async load(): Promise<ExtensionsStoreResult> {
    this.backend = this.backend.asLoading();
    this.notify();
    try {
      this.backend = this.backend.asLoaded(await api.extensions.list());
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
    this.unsubscribe();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function summary(name: string, backend: ExtensionView | null, frontend: FrontendExtension | null): ExtensionSummary {
  const problems: string[] = [];
  if (backend?.failure) problems.push(`Backend: ${BACKEND_STAGES[backend.failure.stage]}: ${backend.failure.message}`);
  if (frontend?.error != null) problems.push(`Frontend: its register function threw: ${frontend.error}`);
  return {
    name,
    label: frontend?.extension.label ?? name,
    description: frontend?.extension.description ?? null,
    icon: frontend?.extension.icon,
    parts: { backend: backend !== null, frontend: frontend !== null },
    status: problems.length > 0 ? "failed" : "loaded",
    problems,
    backend,
    frontend,
  };
}
