/**
 * The frontend extensions app-shell activated (docs/dev/reins-sdk.md *Extensions*): each one's identity, whether its
 * register function ran, and what it has registered now, read from the registries, which record each
 * registration with the extension whose SDK made it. Settings' Extensions section shows them.
 */

import type { Disposer, ExtensionInfo, ExtensionRegistration, ReinsSdk } from "@reins/sdk";
import type { SdkBacking } from "./create-sdk.js";

/** A frontend extension as the host knows it. `status` is `failed` when its register function threw (`error`);
 * a later switch would add `disabled`. */
export interface FrontendExtension {
  readonly extension: ExtensionInfo;
  readonly status: "loaded" | "failed";
  readonly error: string | null;
  readonly registrations: {
    /** View names. */
    views: string[];
    /** Decorators have no names: how many. */
    decorators: number;
    /** Command names, without the `/`. */
    commands: string[];
    settingsPage: boolean;
  };
}

interface Activation { extension: ExtensionInfo; error: string | null }

export class Extensions {
  private readonly activations: Activation[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Disposer[];

  constructor(private readonly registries: Pick<SdkBacking, "views" | "decorators" | "commands" | "settingsPages">) {
    const changed = () => this.notify();
    this.unsubscribe = [registries.views.subscribe(changed), registries.decorators.subscribe(changed), registries.commands.subscribe(changed), registries.settingsPages.subscribe(changed)];
  }

  /**
   * Calls the extension's register function with `sdk`, its own. A throw is logged and recorded as its failure,
   * so the next extension still loads. The disposer runs the extension's and removes it from the list.
   */
  activate(extension: ExtensionRegistration, sdk: ReinsSdk): Disposer {
    const activation: Activation = { extension, error: null };
    this.activations.push(activation);
    let dispose: Disposer | null = null;
    try {
      dispose = extension.register(sdk);
    } catch (error) {
      console.error(`Extension ${extension.name} failed to register:`, error);
      activation.error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
    return () => {
      const index = this.activations.indexOf(activation);
      if (index < 0) return;
      this.activations.splice(index, 1);
      dispose?.();
      this.notify();
    };
  }

  /** Each activated extension, in the order of activation. */
  list(): FrontendExtension[] {
    const { views, decorators, commands, settingsPages } = this.registries;
    return this.activations.map(({ extension, error }) => ({
      extension,
      status: error === null ? "loaded" : "failed",
      error,
      registrations: {
        views: views.registeredBy(extension.name),
        decorators: decorators.registeredBy(extension.name),
        commands: commands.registeredBy(extension.name),
        settingsPage: settingsPages.page(extension.name) !== null,
      },
    }));
  }

  /** Listens for an extension activated or gone, or a registration made or disposed. */
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
