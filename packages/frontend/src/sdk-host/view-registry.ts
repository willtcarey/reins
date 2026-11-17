import type { Disposer, PaneContext, SubjectTypes, View, ViewRenderer, Views, ViewTypes } from "@reins/sdk";

/** The registered view renderers, app state on `AppStore`: containers look up how to show a view here. Each
 * is recorded with the extension that registered it (none for the app's own). */
export class ViewRegistry implements Views {
  private renderers = new Map<string, ViewRenderer>();
  private owners = new Map<string, string>();
  private listeners = new Set<() => void>();
  private declarations = new Map<string, (id: unknown) => readonly string[] | null>();

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
   * Names the tabs of each subject of `type`, by view name in order, for `tabsFor`; `names` gives null for a subject
   * that declares none, which has every tab.
   */
  declareTabs(type: keyof SubjectTypes, names: (id: unknown) => readonly string[] | null): Disposer {
    this.declarations.set(type, names);
    return () => {
      if (this.declarations.get(type) === names) this.declarations.delete(type);
    };
  }

  /**
   * The main area's tabs while it shows `view` (`ViewRenderer.tabOf`), each a view with the subject's ID, `view` itself
   * in its place: those its subject declares (`declareTabs`) that have renderers that are its tabs, else every
   * renderer that is a tab of the same kind of subject, the app's first, then extensions' in registration order. A
   * view shown that is not among its subject's declared tabs comes last. A view that is no tab, or has no renderer, is alone.
   */
  tabsFor(view: View): View[] {
    const tab = this.rendererFor(view)?.tabOf;
    if (!tab) return [view];
    const id = view[tab.parameter];
    const declared = this.declarations.get(tab.type)?.(id);
    const ordered = declared ? this.declaredTabs(tab.type, declared) : this.everyTab(tab.type);
    const tabs = ordered.map(([name, renderer]) => (name === view.view ? view : { view: name, [renderer.tabOf?.parameter ?? tab.parameter]: id }));
    return tabs.includes(view) ? tabs : [...tabs, view];
  }

  private everyTab(type: keyof SubjectTypes): Array<[string, ViewRenderer]> {
    const tabs = [...this.renderers].filter(([, renderer]) => renderer.tabOf?.type === type);
    return [...tabs.filter(([name]) => !this.owners.has(name)), ...tabs.filter(([name]) => this.owners.has(name))];
  }

  private declaredTabs(type: keyof SubjectTypes, names: readonly string[]): Array<[string, ViewRenderer]> {
    return [...new Set(names)].flatMap((name): Array<[string, ViewRenderer]> => {
      const renderer = this.renderers.get(name);
      return renderer?.tabOf?.type === type ? [[name, renderer]] : [];
    });
  }

  /** The title of the view's pane, or null without one; an extension's failing title is logged, not thrown. */
  titleOf(view: View, context: PaneContext): string | null {
    const pane = this.rendererFor(view)?.pane;
    if (!pane) return null;
    try {
      return pane.title(view, context);
    } catch (error) {
      console.error("A view's title failed", error);
      return null;
    }
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
