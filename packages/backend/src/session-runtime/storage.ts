import type { CommitResult, Context, Entry, EntryScan, EntryStructure, ListElement, ListReadOptions, SessionStats, Storage, StorageBranchScan, StoredValue, UsageRow, UsageScan, Value, ValueList, Write } from "@earendil-works/pi-agent-core";

/**
 * A running session's Pi storage: the server's own (`PiStorageAdapter` on the process's database
 * connection), with each commit's writes rewritten by `prepare` just before it is committed, in commit
 * order (inline images become attachments the store holds, as the node's storage did before sending a
 * commit), and every failure reported to `failed` before it reaches Pi (Pi faults its harness on any
 * storage error).
 */
export class SessionStorage implements Storage {
  private commits: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: Storage, private readonly prepare: (writes: Write[]) => Promise<Write[]>, private readonly failed: (error: unknown) => void) {}

  commit(writes: Write[], context: Context): Promise<CommitResult> {
    const result = this.commits.then(async () => this.storage.commit(await this.prepare(writes), context));
    this.commits = result.catch(() => undefined);
    return this.reported(result);
  }

  getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
    return this.reported(this.storage.getEntries(ids, context));
  }

  getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
    return this.reported(this.storage.getValue(address, context));
  }

  scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
    return this.reported(this.storage.scanValues(prefix, context));
  }

  readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, context: Context): Promise<ListElement<T>[]> {
    return this.reported(this.storage.readList(address, options, context));
  }

  scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
    return this.reported(this.storage.scanBranch(query, context));
  }

  scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]> {
    return this.reported(this.storage.scanBranchStructure(query, context));
  }

  scanEntries(query: EntryScan, context: Context): Promise<Entry[]> {
    return this.reported(this.storage.scanEntries(query, context));
  }

  scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]> {
    return this.reported(this.storage.scanUsage(query, context));
  }

  getStats(context: Context): Promise<SessionStats> {
    return this.reported(this.storage.getStats(context));
  }

  close(context: Context): Promise<void> {
    return this.storage.close(context);
  }

  private async reported<T>(call: Promise<T>): Promise<T> {
    try { return await call; }
    catch (error) { this.failed(error); throw error; }
  }
}
