/**
 * TEST HELPER ONLY: Pi's AgentHarness `Storage` for one session, in memory, as the server's copy of a
 * session behaves (the backend's Pi storage on SQLite): commits run Pi's own `prepareStorageCommit`
 * and `validateCommittedWrites`, and every value is copied in and out. Pi's own in-memory storage is not
 * part of its public exports; this one passes Pi's storage conformance suite (`memory-storage.test.ts`).
 */
import {
  prepareStorageCommit,
  resolveListReadOptions,
  validateCommittedWrites,
  value as valueAddress,
  type CommitResult,
  type CommittedWrite,
  type Context,
  type Entry,
  type EntryScan,
  type EntryStructure,
  type ListElement,
  type ListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  type Write,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/** Stored and read back through JSON, as the server's SQLite storage does. */
const copy = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));
const addressKey = (namespace: string, key: string) => JSON.stringify([namespace, key]);

const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function addUsage(total: Usage, usage: Usage): Usage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    ...(total.cacheWrite1h === undefined && usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }),
    ...(total.reasoning === undefined && usage.reasoning === undefined ? {} : { reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0) }),
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

function structure(entry: Entry): EntryStructure {
  return {
    id: entry.id, parentId: entry.parentId, seq: entry.seq, timestamp: entry.timestamp, type: entry.type,
    ...(entry.type === "custom" ? { customType: entry.customType } : {}),
  };
}

export class MemoryStorage implements Storage {
  private nextSeq = 1;
  private readonly entries = new Map<string, Entry>();
  private readonly values = new Map<string, StoredValue<unknown>>();
  private readonly lists = new Map<string, ListElement<unknown>[]>();
  private readonly usage = new Map<string, UsageRow>();
  private commits: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(private readonly now: () => number = Date.now) {}

  async commit(writes: Write[], _context: Context): Promise<CommitResult> {
    this.assertOpen();
    const result = this.commits.then(() => this.apply(writes));
    this.commits = result.catch(() => undefined);
    return result;
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    this.assertOpen();
    return new Map(ids.flatMap(id => {
      const entry = this.entries.get(id);
      return entry ? [[id, copy<Entry>(entry)] as const] : [];
    }));
  }

  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    this.assertOpen();
    const stored = this.values.get(addressKey(address.namespace, address.key));
    return stored && this.storedValue<T>(stored);
  }

  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    this.assertOpen();
    return [...this.values.values()]
      .filter(stored => stored.address.namespace === prefix.namespace && stored.address.key.startsWith(prefix.key))
      // In UTF-8 byte order, as SQLite's binary collation compares keys.
      .toSorted((a, b) => Buffer.compare(Buffer.from(a.address.key), Buffer.from(b.address.key)))
      .map(stored => this.storedValue<T>(stored));
  }

  async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context): Promise<ListElement<T>[]> {
    this.assertOpen();
    const { cursor, order, limit } = resolveListReadOptions(options);
    const elements = (this.lists.get(addressKey(address.namespace, address.key)) ?? [])
      .filter(element => !cursor || (order === "asc" ? element.seq > cursor.seq : element.seq < cursor.seq));
    if (order === "desc") elements.reverse();
    return elements.slice(0, limit).map(({ seq, value }) => ({ seq, value: copy<T>(value) }));
  }

  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    return this.branch(query).map(entry => copy<Entry>(entry));
  }

  async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
    this.assertOpen();
    return this.branch(query).map(structure);
  }

  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    const entries = [...this.entries.values()]
      .filter(entry => (query.fromSeq === undefined || entry.seq >= query.fromSeq) && (query.toSeq === undefined || entry.seq <= query.toSeq))
      .toSorted((a, b) => query.order === "desc" ? b.seq - a.seq : a.seq - b.seq)
      .filter(entry => (!query.type || entry.type === query.type) && (!query.customType || (entry.type === "custom" && entry.customType === query.customType)));
    return (query.limit === undefined ? entries : entries.slice(0, query.limit)).map(entry => copy<Entry>(entry));
  }

  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    this.assertOpen();
    const rows = [...this.usage.values()]
      .filter(row => (query.fromSeq === undefined || row.seq >= query.fromSeq) && (query.toSeq === undefined || row.seq <= query.toSeq))
      .toSorted((a, b) => query.order === "desc" ? b.seq - a.seq : a.seq - b.seq);
    return (query.limit === undefined ? rows : rows.slice(0, query.limit)).map(row => copy<UsageRow>(row));
  }

  async getStats(_context: Context): Promise<SessionStats> {
    this.assertOpen();
    return this.stats();
  }

  /** Everything stored, for assertions: entries in seq order and values by address. */
  contents(): { entries: Entry[]; values: Array<{ namespace: string; key: string; value: unknown; seq: number }> } {
    return {
      entries: [...this.entries.values()].toSorted((a, b) => a.seq - b.seq).map(entry => copy<Entry>(entry)),
      values: [...this.values.values()].map(({ address, value, seq }) => ({ namespace: address.namespace, key: address.key, value: copy<unknown>(value), seq }))
        .toSorted((a, b) => addressKey(a.namespace, a.key) < addressKey(b.namespace, b.key) ? -1 : 1),
    };
  }

  close(_context: Context): Promise<void> {
    this.closing ??= this.commits.then(() => undefined);
    return this.closing;
  }

  private apply(writes: Write[]): CommitResult {
    const prepared = prepareStorageCommit(writes, this.nextSeq, this.now());
    validateCommittedWrites(prepared.writes, this.nextSeq, {
      hasEntryOrUsageId: id => this.entries.has(id) || this.usage.has(id),
      hasEntryId: id => this.entries.has(id),
    });
    for (const write of prepared.writes) this.applyWrite(copy<CommittedWrite>(write));
    this.nextSeq += prepared.writes.length;
    return { ...prepared.result, stats: this.stats() };
  }

  private applyWrite(write: CommittedWrite): void {
    if (write.kind === "entry") {
      if (write.parentId !== null && !this.entries.has(write.parentId)) throw new Error(`Missing parent entry: ${write.parentId}`);
      const { kind: _kind, ...entry } = write;
      this.entries.set(entry.id, entry);
    } else if (write.kind === "usage") {
      const { kind: _kind, ...row } = write;
      this.usage.set(row.id, row);
    } else if (write.kind === "value") {
      const key = addressKey(write.namespace, write.key);
      if (write.op === "delete") this.values.delete(key);
      else this.values.set(key, { address: valueAddress(write.namespace, write.key), value: write.value, seq: write.seq });
    } else {
      const key = addressKey(write.namespace, write.key);
      if (write.op === "delete") this.lists.delete(key);
      else this.lists.set(key, [...this.lists.get(key) ?? [], { seq: write.seq, value: write.value }]);
    }
  }

  /** The branch from `query.start` back through its ancestors, then trimmed and filtered as Pi's `StorageBranchScan` asks. */
  private branch(query: StorageBranchScan): Entry[] {
    let entries: Entry[] = [];
    const seen = new Set<string>();
    for (let entry = this.entries.get(query.start); entry && !seen.has(entry.id); entry = entry.parentId === null ? undefined : this.entries.get(entry.parentId)) {
      seen.add(entry.id);
      entries.push(entry);
    }
    if (entries.length === 0) throw new Error(`Unknown branch entry: ${query.start}`);
    const oldestFirst = query.order === "oldestFirst";
    const stop = entries.findIndex(entry => entry.id === query.stopAtId || entry.type === query.stopAtType);
    if (stop >= 0) entries = oldestFirst ? entries.slice(stop) : entries.slice(0, stop + 1);
    if (oldestFirst) entries.reverse();
    const { cursor } = query;
    if (cursor) entries = entries.filter(entry => oldestFirst ? entry.seq > cursor.seq : entry.seq < cursor.seq);
    if (query.type) entries = entries.filter(entry => entry.type === query.type);
    if (query.customType) entries = entries.filter(entry => entry.type === "custom" && entry.customType === query.customType);
    return query.limit === undefined ? entries : entries.slice(0, query.limit);
  }

  private stats(): SessionStats {
    return {
      messageCount: [...this.entries.values()].filter(entry => entry.type === "message").length,
      usage: [...this.usage.values()].toSorted((a, b) => a.seq - b.seq).reduce((total, row) => addUsage(total, row.usage), ZERO_USAGE),
    };
  }

  private storedValue<T>(stored: StoredValue<unknown>): StoredValue<T> {
    return { address: valueAddress<T>(stored.address.namespace, stored.address.key), value: copy<T>(stored.value), seq: stored.seq };
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("MemoryStorage is closed");
  }
}
