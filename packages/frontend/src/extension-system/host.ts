/**
 * The boundary between frontend extension instances and the app, as the server's `ExtensionHost` is
 * (docs/dev/extensions-overview.md, docs/dev/reins-sdk.md *Extensions*).
 */

import type { Disposer, ExtensionInfo, ExtensionRegistration, ReinsSdk } from "@reins/sdk";
import { sdkDisposers, type SdkBacking } from "../sdk-host/create-sdk.js";

export interface FrontendExtension {
  readonly extension: ExtensionInfo;
  readonly status: "loaded" | "failed";
  readonly error: string | null;
  readonly registrations: {
    views: string[];
    /** Decorators have no names: how many. */
    decorators: number;
    commands: string[];
    settingsPage: boolean;
    sidebarSections: string[];
  };
}

interface Activation { extension: ExtensionInfo; error: string | null }

export class ExtensionHost {
  private readonly activations: Activation[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Disposer[];

  constructor(private readonly registries: Pick<SdkBacking, "views" | "decorators" | "commands" | "settingsPages" | "sidebar">) {
    const changed = () => this.notify();
    this.unsubscribe = [
      registries.views.subscribe(changed),
      registries.decorators.subscribe(changed),
      registries.commands.subscribe(changed),
      registries.settingsPages.subscribe(changed),
      registries.sidebar.subscribe(changed),
    ];
  }

  /** A throw is recorded, not thrown, so the next extension still loads. The disposer also removes what the
   * extension's own disposer forgot. */
  activate(extension: ExtensionRegistration, sdk: ReinsSdk): Disposer {
    const activation: Activation = { extension, error: null };
    this.activations.push(activation);
    let dispose: Disposer | null = null;
    const removeAll = () => {
      for (const remove of sdkDisposers(sdk).splice(0)) {
        try { remove(); } catch (error) { console.error(`Extension ${extension.name}: a registration failed to dispose:`, error); }
      }
    };
    try {
      // An added extension's register function may return nothing, whatever its type says.
      const returned: Disposer | undefined = extension.register(sdk);
      dispose = typeof returned === "function" ? returned : null;
    } catch (error) {
      console.error(`Extension ${extension.name} failed to register:`, error);
      activation.error = error instanceof Error ? error.message : String(error);
      removeAll();
    }
    this.notify();
    return () => {
      const index = this.activations.indexOf(activation);
      if (index < 0) return;
      this.activations.splice(index, 1);
      try {
        dispose?.();
      } catch (error) {
        console.error(`Extension ${extension.name} failed to dispose:`, error);
      }
      removeAll();
      this.notify();
    };
  }

  list(): FrontendExtension[] {
    const { views, decorators, commands, settingsPages, sidebar } = this.registries;
    return this.activations.map(({ extension, error }) => ({
      extension,
      status: error === null ? "loaded" : "failed",
      error,
      registrations: {
        views: views.registeredBy(extension.name),
        decorators: decorators.registeredBy(extension.name),
        commands: commands.registeredBy(extension.name),
        settingsPage: settingsPages.page(extension.name) !== null,
        sidebarSections: sidebar.registeredBy(extension.name),
      },
    }));
  }

  /** Listens for an extension activated or gone, or a registration made or disposed (or the sidebar's sections rearranged). */
  subscribe(listener: () => void): Disposer {
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
