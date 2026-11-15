/**
 * The Launcher's items and their order (docs/features/launcher.md): every command that applies, then each extension's
 * `launcher.items`, gathered each time it opens; ranked by the query, or by what was run lately. Each extension's
 * last answer shows until its next one comes, so the list does not fill in while the user looks at it.
 */

import type { Command, Disposer, Icon, LauncherContext, LauncherItem, Workspace } from "@reins/sdk";
import { fuzzyMatch } from "../../helpers/fuzzy-match.js";
import { commandAvailable, type CommandRegistry } from "../../sdk-host/commands.js";
import type { LauncherSources } from "../../sdk-host/launcher.js";

export type RecentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const RECENT_KEY = "reins:launcher-recent";
/** Where Quick Open kept the sessions opened lately, by session ID. */
const QUICK_OPEN_KEY = "reins:recent-sessions";
const MAX_RECENT = 100;
const ITEMS_TIMEOUT_MS = 1500;

export interface LauncherStoreOptions {
  sources: LauncherSources;
  commands: Pick<CommandRegistry, "list" | "run">;
  /** Where the user is, given to each extension. */
  context: () => Promise<LauncherContext>;
  /** For a command without an icon of its own. */
  commandIcon?: Icon;
  storage?: RecentStorage | null;
  /** How long it waits for an extension's items. */
  timeoutMs?: number;
  /** An extension's items failed or came late: they are left out. */
  onError?: (extension: string, error: unknown) => void;
}

const NO_ICON: Icon = { mount() {} };

function browserStorage(): RecentStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class LauncherStore {
  /** What the latest opening gathered so far, without duplicate IDs. */
  items: readonly LauncherItem[] = [];
  /** Some extension's items are still coming. */
  pending = false;
  /** The IDs of the items run lately, the latest first. */
  recentIds: string[];

  private listeners = new Set<() => void>();
  private opening = 0;
  /** Each extension's last answer, by extension. */
  private answers = new Map<string, readonly LauncherItem[]>();
  private readonly storage: RecentStorage | null;

  constructor(private readonly options: LauncherStoreOptions) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.recentIds = this.loadRecent();
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Gathers the items afresh, starting from each extension's last answer: a new answer replaces it as it comes, and
   * one that fails or comes late leaves it. Resolves once all came or timed out.
   */
  async gather(): Promise<void> {
    const opening = ++this.opening;
    const { sources, onError = logFailure, timeoutMs = ITEMS_TIMEOUT_MS } = this.options;
    const commands = this.commandItems();
    const providers = sources.providers();
    const current = new Set(providers.map(({ extension }) => extension));
    for (const extension of this.answers.keys()) if (!current.has(extension)) this.answers.delete(extension);
    const gathered = providers.map(({ extension }) => this.answers.get(extension) ?? []);
    const show = () => {
      if (opening !== this.opening) return;
      this.items = unique([commands, ...gathered].flat());
      this.notify();
    };
    this.pending = providers.length > 0;
    show();
    try {
      const context = await this.options.context();
      await Promise.all(providers.map(async ({ extension, provide }, index) => {
        try {
          const answer = await withTimeout(Promise.resolve().then(() => provide(context)), timeoutMs);
          // A later gathering's answer is newer.
          if (opening !== this.opening) return;
          gathered[index] = answer;
          this.answers.set(extension, answer);
          show();
        } catch (error) {
          onError(extension, error);
        }
      }));
    } finally {
      if (opening === this.opening) {
        this.pending = false;
        this.notify();
      }
    }
  }

  /**
   * Gathers in the background soon after an extension gives its function (they load after the page), so the first
   * opening has their items.
   */
  followSources(): Disposer {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = this.options.sources.subscribe(() => {
      timer ??= setTimeout(() => {
        timer = null;
        void this.gather();
      }, 0);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }

  /** The items for `query`: with none, those run lately first; else those whose title and detail match, the best first. */
  filter(query: string): LauncherItem[] {
    const rank = new Map(this.recentIds.map((id, index) => [id, index]));
    const recency = (item: LauncherItem) => rank.get(item.id) ?? Infinity;
    if (!query.trim()) return this.items.toSorted((a, b) => recency(a) - recency(b));
    return this.items
      .map((item) => ({ item, score: fuzzyMatch(query.trim(), `${item.title} ${item.detail ?? ""}`) }))
      .filter((scored): scored is { item: LauncherItem; score: number } => scored.score !== null)
      .toSorted((a, b) => a.score - b.score || recency(a.item) - recency(b.item))
      .map(({ item }) => item);
  }

  /** Records the item as run, then runs it; rejects as it does. */
  async run(item: LauncherItem): Promise<void> {
    this.recordRun(item.id);
    await item.run();
  }

  recordRun(id: string): void {
    this.recentIds = [id, ...this.recentIds.filter((recent) => recent !== id)].slice(0, MAX_RECENT);
    this.saveRecent();
  }

  /**
   * Counts the main area coming to be about another session, from any view of it, as running the session's item
   * (`session:<id>`, the sessions extension's), so the sessions the user went to come first however they got there.
   */
  followWorkspace(workspace: Pick<Workspace, "currentSubject" | "onDidChange">): Disposer {
    let shown: string | null = null;
    return workspace.onDidChange(() => {
      const session = workspace.currentSubject("session");
      if (session === shown) return;
      shown = session;
      if (session) this.recordRun(`session:${session}`);
    });
  }

  dispose(): void {
    this.opening++;
    this.listeners.clear();
  }

  private commandItems(): LauncherItem[] {
    const { commands, commandIcon = NO_ICON } = this.options;
    return commands.list()
      .filter(commandAvailable)
      .map((command: Command): LauncherItem => ({
        id: `command:${command.name}`,
        icon: command.icon ?? commandIcon,
        title: command.title ?? command.name,
        detail: `/${command.name}`,
        detailStyle: "code",
        run: () => commands.run({ command, args: "" }),
      }));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private loadRecent(): string[] {
    const stored = readIds(this.storage, RECENT_KEY);
    if (stored) return stored;
    const sessions = (readIds(this.storage, QUICK_OPEN_KEY) ?? []).map((id) => `session:${id}`);
    if (sessions.length > 0) {
      this.saveRecent(sessions);
      try { this.storage?.removeItem(QUICK_OPEN_KEY); } catch { /* Storage refused: read again next time. */ }
    }
    return sessions;
  }

  private saveRecent(ids = this.recentIds): void {
    try {
      this.storage?.setItem(RECENT_KEY, JSON.stringify(ids));
    } catch {
      // Private browsing or a full storage: the order lasts for this page only.
    }
  }
}

function readIds(storage: RecentStorage | null, key: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

function unique(items: readonly LauncherItem[]): LauncherItem[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function logFailure(extension: string, error: unknown): void {
  console.error(`The ${extension} extension's Launcher items were left out:`, error);
}
