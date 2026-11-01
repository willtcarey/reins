import type { Disposer, View, ViewRenderer, Views, ViewTypes } from "@reins/sdk";

/** The registered view renderers, app state on `AppStore`: containers look up how to show a view here. Each
 * is recorded with the extension that registered it (none for the app's own). */
export class ViewRegistry implements Views {
  private renderers = new Map<string, ViewRenderer>();
  private owners = new Map<string, string>();
  private listeners = new Set<() => void>();

  register<K extends keyof ViewTypes>(name: K, renderer: ViewRenderer<ViewTypes[K]>, extension?: string): Disposer {
    if (this.renderers.has(name)) throw new Error(`The ${name} view already has a renderer`);
    if (!renderer.pane && !renderer.inline) throw new Error(`The ${name} view's renderer has no presentation`);
    // Its methods are bivariant: it is only ever given views named `name`, which its feature promised are its type.
    const stored: ViewRenderer = renderer;
    this.renderers.set(name, stored);
    if (extension) this.owners.set(name, extension);
    this.notify();
    return () => {
      if (this.renderers.get(name) !== stored) return;
      this.renderers.delete(name);
      this.owners.delete(name);
      this.notify();
    };
  }

  /** The names of the views `extension` registered, by name. */
  registeredBy(extension: string): string[] {
    return [...this.owners].filter(([, owner]) => owner === extension).map(([name]) => name).toSorted();
  }

  rendererFor(view: View): ViewRenderer | null {
    return this.renderers.get(view.view) ?? null;
  }

  /**
   * The view's identity: its name, and its renderer's `key` for it. A view without a renderer is
   * keyed by its name alone until one is registered.
   */
  keyOf(view: View): string {
    const key = this.rendererFor(view)?.key?.(view);
    return key == null ? view.view : `${view.view}:${key}`;
  }

  /** Listens for a renderer registered or gone. */
  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
