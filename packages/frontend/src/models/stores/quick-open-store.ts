/**
 * Quick Open Store
 *
 * Manages data fetching, recent session tracking, and fuzzy filtering
 * for the quick-open palette (Cmd+K). No component fetches directly —
 * this store owns all server communication and localStorage persistence.
 */

// ---- Types ------------------------------------------------------------------

export interface PaletteItem {
  sessionId: string;
  projectId: number;
  projectName: string;
  taskId: number | null;
  taskTitle: string | null;
  firstMessage: string | null;
  updatedAt: string;
}

export interface FuzzyResult {
  item: PaletteItem;
  score: number;
}

// ---- Fuzzy matching ---------------------------------------------------------

/**
 * Fuzzy match: checks if all characters in `query` appear in `text` in order
 * (case-insensitive). Returns a score where lower is better (tighter match),
 * or null if no match.
 *
 * Score = total distance spanned by the match minus the query length,
 * plus a penalty for each gap between consecutive matched characters.
 */
export function fuzzyMatch(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  let qi = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;
  let gaps = 0;
  let prevMatchIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatchIndex === -1) firstMatchIndex = ti;
      if (prevMatchIndex !== -1 && ti - prevMatchIndex > 1) {
        gaps += ti - prevMatchIndex - 1;
      }
      prevMatchIndex = ti;
      lastMatchIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return null;

  // Score: span of the match + gaps penalty. Lower is better.
  const span = lastMatchIndex - firstMatchIndex + 1;
  return span - q.length + gaps;
}

/**
 * Build a searchable string for a palette item.
 */
export function itemSearchText(item: PaletteItem): string {
  const context = item.taskTitle || "Assistant";
  const message = item.firstMessage || "";
  return `${item.projectName} ${context} ${message}`;
}

/**
 * Filter and rank items by fuzzy match against query.
 * Empty query returns items reordered by recency (recently viewed first).
 */
export function filterItems(
  items: PaletteItem[],
  query: string,
  recentIds?: string[],
): PaletteItem[] {
  if (!query.trim()) {
    if (!recentIds || recentIds.length === 0) return items;
    // Reorder: recently viewed first, then the rest in original order
    const recentIndex = new Map(recentIds.map((id, i) => [id, i]));
    const recent: PaletteItem[] = [];
    const rest: PaletteItem[] = [];
    for (const item of items) {
      if (recentIndex.has(item.sessionId)) {
        recent.push(item);
      } else {
        rest.push(item);
      }
    }
    recent.sort((a, b) => recentIndex.get(a.sessionId)! - recentIndex.get(b.sessionId)!);
    return [...recent, ...rest];
  }

  const results: FuzzyResult[] = [];
  for (const item of items) {
    const text = itemSearchText(item);
    const score = fuzzyMatch(query, text);
    if (score !== null) {
      results.push({ item, score });
    }
  }

  results.sort((a, b) => a.score - b.score);
  return results.map((r) => r.item);
}

// ---- Store ------------------------------------------------------------------

export type QuickOpenStoreListener = () => void;

export class QuickOpenStore {
  private static readonly STORAGE_KEY = "reins:recent-sessions";
  private static readonly MAX_RECENT = 50;

  // ---- Public reactive state ------------------------------------------------

  items: PaletteItem[] = [];
  loading = false;

  /** Most recently viewed session IDs, newest first. */
  recentIds: string[] = QuickOpenStore._loadRecent();

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<QuickOpenStoreListener>();

  subscribe(fn: QuickOpenStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Data fetching --------------------------------------------------------

  /** Fetch all palette items from the server. */
  async fetchItems() {
    this.loading = this.items.length === 0;
    if (this.loading) this.notify();
    try {
      const res = await fetch("/api/palette");
      if (res.ok) {
        this.items = await res.json();
      }
    } catch {
      // Keep cached items on error
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  // ---- Filtering ------------------------------------------------------------

  /** Filter items by query, applying recency ordering for empty queries. */
  filter(query: string): PaletteItem[] {
    return filterItems(this.items, query, this.recentIds);
  }

  // ---- Recent session tracking ----------------------------------------------

  /** Record a session as most recently viewed. */
  recordVisit(sessionId: string) {
    this.recentIds = [sessionId, ...this.recentIds.filter((id) => id !== sessionId)]
      .slice(0, QuickOpenStore.MAX_RECENT);
    QuickOpenStore._saveRecent(this.recentIds);
    // No notify needed — recency only affects filter() output at query time
  }

  private static _loadRecent(): string[] {
    try {
      const raw = localStorage.getItem(QuickOpenStore.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  }

  private static _saveRecent(ids: string[]) {
    try {
      localStorage.setItem(QuickOpenStore.STORAGE_KEY, JSON.stringify(ids));
    } catch { /* ignore */ }
  }
}
