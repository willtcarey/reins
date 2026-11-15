import type { Disposer, LauncherItems } from "@reins/sdk";

/** An extension's function for its Launcher items. */
export interface LauncherSource {
  readonly extension: string;
  readonly provide: LauncherItems;
}

/** Each extension's `launcher.items` function, app state on `AppStore`, in the order the extensions first gave one. */
export class LauncherSources {
  private sources = new Map<string, LauncherItems>();
  private listeners = new Set<() => void>();

  /** The extension's function, in place of the one it gave before. */
  set(extension: string, provide: LauncherItems): Disposer {
    this.sources.set(extension, provide);
    this.notify();
    return () => {
      if (this.sources.get(extension) !== provide) return;
      this.sources.delete(extension);
      this.notify();
    };
  }

  providers(): LauncherSource[] {
    return [...this.sources].map(([extension, provide]) => ({ extension, provide }));
  }

  registeredBy(extension: string): boolean {
    return this.sources.has(extension);
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
