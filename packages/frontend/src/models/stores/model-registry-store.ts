import type { ModelInfo } from "@backend/pi/registry.js";
import type { RuntimeProviderInfo as ProviderInfo } from "@backend/pi/model-catalog.js";
import { api } from "../api.js";
import { providerLabel } from "../settings.js";

export interface ApiKeyState {
  provider: string;
  label: string;
  availabilitySource: "db" | "env" | "oauth" | "local" | null;
  availabilitySources: ("db" | "env" | "oauth" | "local")[];
}

export type ModelRegistryStoreResult = { ok: true } | { error: string };
export type ModelRegistryStoreListener = () => void;

export class ModelRegistryStore {
  loading = false;
  providers: ProviderInfo[] = [];

  private _listeners = new Set<ModelRegistryStoreListener>();

  subscribe(fn: ModelRegistryStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  get apiKeys(): ApiKeyState[] {
    return this.providers
      .filter((providerInfo) => providerInfo.isAvailable)
      .map((providerInfo) => ({
        provider: providerInfo.provider,
        label: providerLabel(providerInfo.provider),
        availabilitySource: providerInfo.availabilitySource,
        availabilitySources: providerInfo.availabilitySources,
      }));
  }

  get unconfiguredProviders(): ProviderInfo[] {
    return this.providers.filter((provider) => !provider.isAvailable);
  }

  get availableProviders(): ProviderInfo[] {
    return this.providers.filter((provider) => provider.isAvailable);
  }

  getModelsForProvider(providerName: string): ModelInfo[] {
    return this.providers.find((provider) => provider.provider === providerName)?.models ?? [];
  }

  findProvider(providerName: string): ProviderInfo | null {
    return this.providers.find((provider) => provider.provider === providerName) ?? null;
  }

  findModel(providerName: string, modelId: string): ModelInfo | null {
    return this.getModelsForProvider(providerName).find((model) => model.id === modelId) ?? null;
  }

  async load(): Promise<ModelRegistryStoreResult> {
    this.loading = true;
    this.notify();

    try {
      this.providers = await api.models.list();
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.loading = false;
      this.notify();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
