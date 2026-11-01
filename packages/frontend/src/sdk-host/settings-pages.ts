/**
 * The extensions' Settings pages (the SDK's `settings.register`): one for each extension that registered one,
 * which the settings page lists after its own sections.
 */

import type { Disposer, ExtensionInfo, SettingsPage } from "@reins/sdk";

export interface ExtensionSettingsPage {
  readonly extension: ExtensionInfo;
  readonly settings: SettingsPage;
}

export class SettingsPages {
  private readonly byExtension = new Map<string, ExtensionSettingsPage>();
  private readonly listeners = new Set<() => void>();

  register(extension: ExtensionInfo, settings: SettingsPage): Disposer {
    if (this.byExtension.has(extension.name)) throw new Error(`The ${extension.name} extension already has a Settings page`);
    const page = { extension, settings };
    this.byExtension.set(extension.name, page);
    this.notify();
    return () => {
      if (this.byExtension.get(extension.name) !== page) return;
      this.byExtension.delete(extension.name);
      this.notify();
    };
  }

  /** Each extension's page, by label. */
  pages(): ExtensionSettingsPage[] {
    return [...this.byExtension.values()].toSorted((a, b) => a.extension.label.localeCompare(b.extension.label));
  }

  page(extensionName: string): ExtensionSettingsPage | null {
    return this.byExtension.get(extensionName) ?? null;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}
