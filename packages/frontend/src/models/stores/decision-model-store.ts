/** The default decision model (Settings → Models → Decision model): the models `reins.decisions.list()` gives,
 * and the one chosen, the `decision_model` setting. */

import type { DecisionModelView } from "@backend/sdk-host/decisions.js";
import { api } from "../api.js";

export type DecisionModelStoreResult = { ok: true } | { error: string };

export class DecisionModelStore {
  loading = false;
  models: DecisionModelView[] = [];
  /** The stored ID, which may no longer be listed. */
  selected: string | null = null;

  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<DecisionModelStoreResult> {
    this.loading = true;
    this.notify();
    try {
      const [models, settings] = await Promise.all([api.decisions.models(), api.settings.list(["decision_model"])]);
      this.models = models;
      const entry = settings.find(setting => setting.key === "decision_model");
      this.selected = entry?.key === "decision_model" ? entry.value : null;
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  /** `null`: none, so a call without a model fails until one is chosen. */
  async select(id: string | null): Promise<DecisionModelStoreResult> {
    try {
      if (id === null) await api.settings.delete("decision_model");
      else await api.settings.put("decision_model", id);
      this.selected = id;
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.notify();
    }
  }
}
