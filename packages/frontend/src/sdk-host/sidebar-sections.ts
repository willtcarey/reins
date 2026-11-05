/**
 * The sidebar's sections (the SDK's `sidebar.registerSection`) and how the user arranged them (Settings →
 * Sidebar): their order and which are off, stored as the `sidebar_sections` setting. The sidebar shows
 * `shown()`; the settings section edits `arrangement()`.
 */

import type { Disposer, SidebarSection } from "@reins/sdk";

/** The user's arrangement, by section ID. `order` may name sections not registered now, which keep their place. */
export interface SidebarLayout {
  readonly order: readonly string[];
  readonly hidden: readonly string[];
}

/** Where the layout is kept: the server's settings in the app. */
export interface SidebarLayoutStorage {
  load(): Promise<SidebarLayout | null>;
  save(layout: SidebarLayout): Promise<void>;
}

export interface ArrangedSection {
  readonly section: SidebarSection;
  /** The extension that registered it; null for the app's own. */
  readonly extension: string | null;
  readonly visible: boolean;
}

const SECTION_ID = /^[a-z0-9][a-z0-9-]*$/;

interface Registered { section: SidebarSection; extension: string | null }

export class SidebarSections {
  private registered: Registered[] = [];
  private layout: SidebarLayout = { order: [], hidden: [] };
  private listeners = new Set<() => void>();

  constructor(private readonly storage: SidebarLayoutStorage | null = null) {}

  register(section: SidebarSection, extension?: string): Disposer {
    if (!SECTION_ID.test(section.id)) throw new Error(`"${section.id}" is not a sidebar section ID: use lowercase letters, digits and hyphens`);
    if (this.registered.some((entry) => entry.section.id === section.id)) throw new Error(`The sidebar already has a "${section.id}" section`);
    const entry: Registered = { section, extension: extension ?? null };
    this.registered.push(entry);
    this.notify();
    return () => {
      const index = this.registered.indexOf(entry);
      if (index < 0) return;
      this.registered.splice(index, 1);
      this.notify();
    };
  }

  /** The IDs of the sections `extension` registered, in registration order. */
  registeredBy(extension: string): string[] {
    return this.registered.filter((entry) => entry.extension === extension).map((entry) => entry.section.id);
  }

  /** Every registered section in the user's order (those it does not name after, in registration order), with whether it is on. */
  arrangement(): ArrangedSection[] {
    const position = new Map(this.layout.order.map((id, index) => [id, index]));
    const rank = (entry: Registered) => position.get(entry.section.id) ?? Number.POSITIVE_INFINITY;
    const hidden = new Set(this.layout.hidden);
    return this.registered
      .map((entry, index) => ({ entry, index }))
      .toSorted((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
      .map(({ entry }) => ({ section: entry.section, extension: entry.extension, visible: !hidden.has(entry.section.id) }));
  }

  /** The sections the sidebar shows, in order. */
  shown(): SidebarSection[] {
    return this.arrangement().filter((arranged) => arranged.visible).map((arranged) => arranged.section);
  }

  /** Loads the user's arrangement; until then (and when there is none) sections are in registration order, all on. */
  async load(): Promise<void> {
    const layout = await this.storage?.load();
    if (!layout) return;
    this.layout = layout;
    this.notify();
  }

  /** Turns a section on or off, at once, and stores it. */
  setVisible(id: string, visible: boolean): Promise<void> {
    const hidden = this.layout.hidden.filter((hiddenId) => hiddenId !== id);
    return this.change({ order: this.layout.order, hidden: visible ? hidden : [...hidden, id] });
  }

  /** Moves a section `by` places (-1 up, 1 down) among the registered ones, at once, and stores the order. */
  move(id: string, by: number): Promise<void> {
    const ids = this.arrangement().map((arranged) => arranged.section.id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return Promise.resolve();
    ids.splice(to, 0, ...ids.splice(from, 1));
    const absent = this.layout.order.filter((other) => !ids.includes(other));
    return this.change({ order: [...ids, ...absent], hidden: this.layout.hidden });
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shown at once; put back when it cannot be stored, and the caller is told why. */
  private async change(layout: SidebarLayout): Promise<void> {
    const previous = this.layout;
    this.layout = layout;
    this.notify();
    try {
      await this.storage?.save(layout);
    } catch (error) {
      if (this.layout === layout) {
        this.layout = previous;
        this.notify();
      }
      throw error;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
