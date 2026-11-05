/**
 * Tells listeners what changed, once a microtask: the keys added since the last time, together. A burst of
 * changes (a list loading, a run ending) is one event, and a listener hears no key twice in it.
 */
export class ChangeFeed<K> {
  private listeners = new Set<(keys: K[]) => void>();
  private pending = new Set<K>();
  private scheduled = false;

  get listened(): boolean {
    return this.listeners.size > 0;
  }

  listen(listener: (keys: K[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(keys: Iterable<K>): void {
    for (const key of keys) this.pending.add(key);
    if (this.scheduled || this.pending.size === 0) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const keys = [...this.pending];
    this.pending.clear();
    if (keys.length === 0) return;
    for (const listener of this.listeners) listener(keys);
  }
}

/**
 * What each key looks like now, to tell which changed: `update` compares the values `read` gives with the last
 * ones and gives the keys whose value differs, appeared or went. Values compare as JSON (plain SDK values).
 */
export class Snapshot<K> {
  private last = new Map<K, string>();

  changed(now: ReadonlyMap<K, unknown>): K[] {
    const next = new Map([...now].map(([key, value]) => [key, JSON.stringify(value)]));
    const changed = [...next].filter(([key, value]) => this.last.get(key) !== value).map(([key]) => key);
    for (const key of this.last.keys()) if (!next.has(key)) changed.push(key);
    this.last = next;
    return changed;
  }
}
