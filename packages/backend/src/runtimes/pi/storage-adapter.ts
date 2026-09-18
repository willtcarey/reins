import type { Database } from "bun:sqlite";
import {
  prepareStorageCommit,
  resolveListReadOptions,
  validateCommittedWrites,
  value,
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
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  type Write,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type StoredEntryEnvelope<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "id" | "parentId" | "seq">
  : never;

type EntryRow = {
  harness_id: string;
  seq: number;
  message_json: string;
  parent_harness_id: string | null;
};

type ValueRow = {
  namespace: string;
  key: string;
  seq: number;
  value_json: string;
};

type UsageDbRow = {
  id: string;
  seq: number;
  entry_id: string | null;
  adjustment: number;
  usage_json: string;
  details_json: string | null;
};

function encodeEntry(entry: Entry & { kind?: "entry" }): StoredEntryEnvelope {
  const { id: _id, parentId: _parentId, seq: _seq, kind: _kind, ...envelope } = entry;
  return envelope;
}

function decodeEntry(row: EntryRow): Entry {
  const envelope: StoredEntryEnvelope = JSON.parse(row.message_json);
  return {
    ...envelope,
    id: row.harness_id,
    parentId: row.parent_harness_id,
    seq: row.seq,
  };
}

function entryStructure(entry: Entry): EntryStructure {
  return {
    id: entry.id,
    parentId: entry.parentId,
    seq: entry.seq,
    timestamp: entry.timestamp,
    type: entry.type,
    ...(entry.type === "custom" ? { customType: entry.customType } : {}),
  };
}

function addUsage(total: Usage, usage: Usage): Usage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    ...(total.cacheWrite1h === undefined && usage.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }),
    ...(total.reasoning === undefined && usage.reasoning === undefined
      ? {}
      : { reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0) }),
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

export class PiStorageAdapter implements Storage {
  private commitQueue: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;

  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.assertSessionExists();
  }

  async commit(writes: Write[], _context: Context) {
    this.assertOpen();
    const result = this.commitQueue.then(() => this.applyCommit(writes));
    this.commitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    this.assertOpen();
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .query<EntryRow, string[]>(
        `SELECT child.harness_id, child.seq, child.message_json,
                parent.harness_id AS parent_harness_id
         FROM session_messages child
         LEFT JOIN session_messages parent ON parent.id = child.parent_id
         WHERE child.session_id = ? AND child.harness_id IN (${placeholders})`,
      )
      .all(this.sessionId, ...ids);
    const rowsById = new Map(rows.map((row) => [row.harness_id, row]));
    const entries = new Map<string, Entry>();
    for (const id of ids) {
      const row = rowsById.get(id);
      if (row) entries.set(id, decodeEntry(row));
    }
    return entries;
  }

  async getValue<T>(address: Value<T>, _context: Context) {
    this.assertOpen();
    const row = this.db
      .query<ValueRow, [string, string, string]>(
        `SELECT namespace, key, seq, value_json
         FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?`,
      )
      .get(this.sessionId, address.namespace, address.key);
    if (!row) return undefined;
    const storedValue: T = JSON.parse(row.value_json);
    return { address: value<T>(row.namespace, row.key), value: storedValue, seq: row.seq };
  }

  async scanValues<T>(prefix: Value<T>, _context: Context) {
    this.assertOpen();
    const rows = this.db
      .query<ValueRow, [string, string, string, string]>(
        `SELECT namespace, key, seq, value_json
         FROM pi_values
         WHERE session_id = ? AND namespace = ? AND substr(key, 1, length(?)) = ?
         ORDER BY key COLLATE BINARY`,
      )
      .all(this.sessionId, prefix.namespace, prefix.key, prefix.key);
    return rows.map((row) => {
      const storedValue: T = JSON.parse(row.value_json);
      return { address: value<T>(row.namespace, row.key), value: storedValue, seq: row.seq };
    });
  }

  async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context) {
    this.assertOpen();
    const resolved = resolveListReadOptions(options);
    const cursorSql = resolved.cursor ? `AND seq ${resolved.order === "asc" ? ">" : "<"} ?` : "";
    const parameters: (string | number)[] = [this.sessionId, address.namespace, address.key];
    if (resolved.cursor) parameters.push(resolved.cursor.seq);
    parameters.push(resolved.limit);

    const rows = this.db
      .query<{ seq: number; value_json: string }, (string | number)[]>(
        `SELECT seq, value_json FROM pi_lists
         WHERE session_id = ? AND namespace = ? AND key = ? ${cursorSql}
         ORDER BY seq ${resolved.order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...parameters);
    return rows.map((row): ListElement<T> => ({ seq: row.seq, value: JSON.parse(row.value_json) }));
  }

  async scanEntries(query: EntryScan, _context: Context) {
    this.assertOpen();
    return this.readEntries(query);
  }

  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    this.assertOpen();
    let sql = "SELECT * FROM pi_usage WHERE session_id = ?";
    const parameters: (string | number)[] = [this.sessionId];
    if (query.fromSeq !== undefined) { sql += " AND seq >= ?"; parameters.push(query.fromSeq); }
    if (query.toSeq !== undefined) { sql += " AND seq <= ?"; parameters.push(query.toSeq); }
    sql += ` ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"}`;
    if (query.limit !== undefined) { sql += " LIMIT ?"; parameters.push(query.limit); }

    return this.db.query<UsageDbRow, (string | number)[]>(sql).all(...parameters).map((row) => ({
      id: row.id,
      seq: row.seq,
      usage: JSON.parse(row.usage_json),
      adjustment: row.adjustment === 1,
      ...(row.entry_id === null ? {} : { entryId: row.entry_id }),
      ...(row.details_json === null ? {} : { details: JSON.parse(row.details_json) }),
    }));
  }

  async getStats(_context: Context): Promise<SessionStats> {
    this.assertOpen();
    return this.readStats();
  }

  async scanBranch(query: StorageBranchScan, _context: Context) {
    this.assertOpen();
    return this.readBranch(query);
  }

  async scanBranchStructure(query: StorageBranchScan, _context: Context) {
    this.assertOpen();
    return this.readBranch(query).map(entryStructure);
  }

  close(_context: Context) {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.closePromise = this.commitQueue.then(() => { this.state = "closed"; });
    return this.closePromise;
  }

  private applyCommit(writes: Write[]) {
    return this.db.transaction(() => {
      const session = this.db
        .query<{ harness_next_seq: number }, [string]>(
          "SELECT harness_next_seq FROM sessions WHERE id = ?",
        )
        .get(this.sessionId);
      if (!session) throw new Error(`Unknown session: ${this.sessionId}`);

      const prepared = prepareStorageCommit(writes, session.harness_next_seq, this.now());
      validateCommittedWrites(prepared.writes, session.harness_next_seq, {
        hasEntryOrUsageId: (id) => this.hasEntry(id) || this.hasUsage(id),
        hasEntryId: (id) => this.hasEntry(id),
      });
      for (const write of prepared.writes) this.applyWrite(write);
      this.db.query("UPDATE sessions SET harness_next_seq = ? WHERE id = ?")
        .run(session.harness_next_seq + prepared.writes.length, this.sessionId);
      return { ...prepared.result, stats: this.readStats() };
    })();
  }

  private applyWrite(write: CommittedWrite): void {
    if (write.kind === "entry") {
      const parentId = write.parentId === null ? null : this.rowIdForEntry(write.parentId);
      const envelope = encodeEntry(write);
      const role = write.type === "message" ? write.message.role : write.type;
      this.db.query(
        `INSERT INTO session_messages
           (session_id, seq, parent_id, harness_id, role, message_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.sessionId,
        write.seq,
        parentId,
        write.id,
        role,
        JSON.stringify(envelope),
        new Date(write.timestamp).toISOString(),
      );
      return;
    }

    if (write.kind === "usage") {
      this.db.query(
        `INSERT INTO pi_usage
           (session_id, id, seq, entry_id, adjustment, usage_json, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.sessionId,
        write.id,
        write.seq,
        write.entryId ?? null,
        Number(write.adjustment),
        JSON.stringify(write.usage),
        write.details === undefined ? null : JSON.stringify(write.details),
      );
      return;
    }

    if (write.kind === "value") {
      if (write.op === "delete") {
        this.db.query(
          "DELETE FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?",
        ).run(this.sessionId, write.namespace, write.key);
      } else {
        this.db.query(
          `INSERT INTO pi_values (session_id, namespace, key, seq, value_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, namespace, key)
           DO UPDATE SET seq = excluded.seq, value_json = excluded.value_json`,
        ).run(this.sessionId, write.namespace, write.key, write.seq, JSON.stringify(write.value));
      }
      return;
    }

    if (write.op === "delete") {
      this.db.query(
        "DELETE FROM pi_lists WHERE session_id = ? AND namespace = ? AND key = ?",
      ).run(this.sessionId, write.namespace, write.key);
    } else {
      this.db.query(
        `INSERT INTO pi_lists (session_id, namespace, key, seq, value_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(this.sessionId, write.namespace, write.key, write.seq, JSON.stringify(write.value));
    }
  }

  private readEntries(query: EntryScan): Entry[] {
    let sql = `SELECT child.harness_id, child.seq, child.message_json,
                      parent.harness_id AS parent_harness_id
               FROM session_messages child
               LEFT JOIN session_messages parent ON parent.id = child.parent_id
               WHERE child.session_id = ?`;
    const parameters: (string | number)[] = [this.sessionId];
    if (query.fromSeq !== undefined) { sql += " AND child.seq >= ?"; parameters.push(query.fromSeq); }
    if (query.toSeq !== undefined) { sql += " AND child.seq <= ?"; parameters.push(query.toSeq); }
    sql += ` ORDER BY child.seq ${query.order === "desc" ? "DESC" : "ASC"}`;

    let entries = this.db.query<EntryRow, (string | number)[]>(sql).all(...parameters).map(decodeEntry);
    if (query.type) entries = entries.filter((entry) => entry.type === query.type);
    if (query.customType) {
      entries = entries.filter((entry) => entry.type === "custom" && entry.customType === query.customType);
    }
    return query.limit === undefined ? entries : entries.slice(0, query.limit);
  }

  private readBranch(query: StorageBranchScan): Entry[] {
    const rows = this.db.query<EntryRow, [string, string, string]>(
      `WITH RECURSIVE branch(id, parent_id, depth, visited) AS (
         SELECT id, parent_id, 0, printf('/%d/', id)
         FROM session_messages
         WHERE session_id = ? AND harness_id = ?
         UNION ALL
         SELECT parent.id, parent.parent_id, branch.depth + 1,
                branch.visited || parent.id || '/'
         FROM session_messages parent
         JOIN branch ON parent.id = branch.parent_id
         WHERE parent.session_id = ?
           AND instr(branch.visited, printf('/%d/', parent.id)) = 0
       )
       SELECT entry.harness_id, entry.seq, entry.message_json,
              parent.harness_id AS parent_harness_id
       FROM branch
       JOIN session_messages entry ON entry.id = branch.id
       LEFT JOIN session_messages parent
         ON parent.id = entry.parent_id AND parent.session_id = entry.session_id
       ORDER BY branch.depth`,
    ).all(this.sessionId, query.start, this.sessionId);
    if (rows.length === 0) throw new Error(`Unknown branch entry: ${query.start}`);
    let entries = rows.map(decodeEntry);
    const oldestFirst = query.order === "oldestFirst";
    const stopIndex = entries.findIndex((entry) =>
      entry.id === query.stopAtId || entry.type === query.stopAtType
    );
    if (stopIndex >= 0) entries = oldestFirst ? entries.slice(stopIndex) : entries.slice(0, stopIndex + 1);
    if (oldestFirst) entries.reverse();
    if (query.cursor) {
      entries = entries.filter((entry) => oldestFirst ? entry.seq > query.cursor!.seq : entry.seq < query.cursor!.seq);
    }
    if (query.type) entries = entries.filter((entry) => entry.type === query.type);
    if (query.customType) {
      entries = entries.filter((entry) => entry.type === "custom" && entry.customType === query.customType);
    }
    return query.limit === undefined ? entries : entries.slice(0, query.limit);
  }

  private readStats(): SessionStats {
    const messageStats = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM session_messages
       WHERE session_id = ? AND json_extract(message_json, '$.type') = 'message'`,
    ).get(this.sessionId);
    if (!messageStats) throw new Error(`Unable to read session stats: ${this.sessionId}`);
    const rows = this.db.query<{ usage_json: string }, [string]>(
      "SELECT usage_json FROM pi_usage WHERE session_id = ? ORDER BY seq",
    ).all(this.sessionId);
    return {
      messageCount: messageStats.count,
      usage: rows.reduce((total, row) => {
        const usage: Usage = JSON.parse(row.usage_json);
        return addUsage(total, usage);
      }, ZERO_USAGE),
    };
  }

  private hasEntry(id: string): boolean {
    return Boolean(this.db.query(
      "SELECT 1 FROM session_messages WHERE session_id = ? AND harness_id = ?",
    ).get(this.sessionId, id));
  }

  private hasUsage(id: string): boolean {
    return Boolean(this.db.query(
      "SELECT 1 FROM pi_usage WHERE session_id = ? AND id = ?",
    ).get(this.sessionId, id));
  }

  private rowIdForEntry(id: string): number {
    const row = this.db.query<{ id: number }, [string, string]>(
      "SELECT id FROM session_messages WHERE session_id = ? AND harness_id = ?",
    ).get(this.sessionId, id);
    if (!row) throw new Error(`Missing parent entry: ${id}`);
    return row.id;
  }

  private assertSessionExists(): void {
    const session = this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) throw new Error(`Unknown session: ${this.sessionId}`);
  }

  private assertOpen(): void {
    if (this.state !== "open") throw new Error("PiStorageAdapter is closed");
  }
}
