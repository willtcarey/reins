import type { Disposer, ViewName, ViewOf, ViewRendererMap, Views } from "./contract.js";

/** The registered view renderers, app state on `AppStore`: containers look up how to show a view here. */
export class ViewRegistry implements Views {
  private renderers: Partial<ViewRendererMap> = {};
  private listeners = new Set<() => void>();

  register<K extends ViewName>(name: K, renderer: ViewRendererMap[K]): Disposer {
    if (this.renderers[name]) throw new Error(`The ${name} view already has a renderer`);
    if (!renderer.pane && !renderer.inline) throw new Error(`The ${name} view's renderer has no presentation`);
    this.renderers[name] = renderer;
    this.notify();
    return () => {
      if (this.renderers[name] !== renderer) return;
      delete this.renderers[name];
      this.notify();
    };
  }

  rendererFor<K extends ViewName>(view: ViewOf<K>): ViewRendererMap[K] | null {
    return this.renderers[view.view] ?? null;
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
