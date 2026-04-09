import type { ModelInfo, ProviderInfo } from "../model-catalog.js";
import { providerLabel } from "../settings.js";

export interface ApiKeyState {
  provider: string;
  label: string;
  keySource: "db" | "env" | "oauth" | "local" | null;
  keySources: ("db" | "env" | "oauth" | "local")[];
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
      .filter((providerInfo) => providerInfo.hasKey)
      .map((providerInfo) => ({
        provider: providerInfo.provider,
        label: providerLabel(providerInfo.provider),
        keySource: providerInfo.keySource,
        keySources: providerInfo.keySources ?? (providerInfo.keySource ? [providerInfo.keySource] : []),
      }));
  }

  get unconfiguredProviders(): ProviderInfo[] {
    return this.providers.filter((provider) => !provider.hasKey);
  }

  get availableProviders(): ProviderInfo[] {
    return this.providers.filter((provider) => provider.hasKey);
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
      const res = await fetch("/api/models");
      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this.providers = await res.json();
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

async function errorDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error ?? `HTTP ${response.status}`;
}
