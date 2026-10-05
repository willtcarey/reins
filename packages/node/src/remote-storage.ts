import { value as valueAddress, type CommitResult, type Context, type Entry, type EntryScan, type EntryStructure, type ListElement, type ListReadOptions, type SessionStats, type Storage, type StorageBranchScan, type StoredValue, type UsageRow, type UsageScan, type Value, type ValueList, type Write } from "@earendil-works/pi-agent-core";
import type { StorageCommit, StorageCommitResult, StorageRead, StorageReadResult } from "@reins/node-protocol";
import { z } from "zod";

/** The node's view of the server's session storage (`storage.read`, `storage.commit` over the attached connection). */
export interface StorageServer {
  readStorage(input: StorageRead): Promise<StorageReadResult>;
  commitStorage(input: StorageCommit): Promise<StorageCommitResult>;
}

/** Pi's own bodies cross as the JSON Pi's storage on the server wrote and read; the wire schema checked
 * their envelope, so they are Pi's types again here. */
const fromPi = <T>(value: unknown): T => z.custom<T>().parse(value);
const answers = <Op extends StorageReadResult["op"]>(result: StorageReadResult, op: Op): result is Extract<StorageReadResult, { op: Op }> => result.op === op;

/**
 * Pi's `Storage` for one session over the server connection (ADR-015): every read and every commit is a
 * call to the server, which serves it from Pi's storage on its canonical copy. Nothing is cached or kept
 * here. Commits are sent one at a time in admission order (the server assigns their seqs), each under a
 * fresh `commitId` so that `server` may resend one whose reply it lost; a refused commit rejects with the
 * connection's `RpcFailure`. `server` is the node's server-call surface (a connection, or whatever
 * resolves the node's current one). `prepare`, when given, rewrites each commit's writes just before it is
 * sent, in commit order (the node uploads inline images there). `close()` seals admission and waits for
 * admitted commits; it releases nothing on the server.
 */
export class RemoteStorage implements Storage {
  private commits: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(private readonly sessionId: string, private readonly server: StorageServer, private readonly prepare?: (writes: Write[]) => Promise<Write[]>) {}

  async commit(writes: Write[], _context: Context): Promise<CommitResult> {
    this.assertOpen();
    const result = this.commits.then(async () => this.server.commitStorage({
      sessionId: this.sessionId, commitId: crypto.randomUUID(), writes: this.prepare ? await this.prepare(writes) : writes,
    }));
    this.commits = result.catch(() => undefined);
    return fromPi<CommitResult>(await result);
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    const { entries } = await this.read({ sessionId: this.sessionId, op: "getEntries", args: { ids } });
    return new Map(fromPi<Entry[]>(entries).map(entry => [entry.id, entry]));
  }

  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    const { value: stored } = await this.read({ sessionId: this.sessionId, op: "getValue", args: { namespace: address.namespace, key: address.key } });
    return stored === null ? undefined : { address: valueAddress<T>(stored.namespace, stored.key), value: fromPi<T>(stored.value), seq: stored.seq };
  }

  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    const { values } = await this.read({ sessionId: this.sessionId, op: "scanValues", args: { namespace: prefix.namespace, key: prefix.key } });
    return values.map(stored => ({ address: valueAddress<T>(stored.namespace, stored.key), value: fromPi<T>(stored.value), seq: stored.seq }));
  }

  async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context): Promise<ListElement<T>[]> {
    const args = { namespace: address.namespace, key: address.key, ...(options === undefined ? {} : { options }) };
    const { elements } = await this.read({ sessionId: this.sessionId, op: "readList", args });
    return elements.map(element => ({ seq: element.seq, value: fromPi<T>(element.value) }));
  }

  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    return fromPi<Entry[]>((await this.read({ sessionId: this.sessionId, op: "scanBranch", args: query })).entries);
  }

  async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
    return (await this.read({ sessionId: this.sessionId, op: "scanBranchStructure", args: query })).entries;
  }

  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    return fromPi<Entry[]>((await this.read({ sessionId: this.sessionId, op: "scanEntries", args: query })).entries);
  }

  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    return fromPi<UsageRow[]>((await this.read({ sessionId: this.sessionId, op: "scanUsage", args: query })).rows);
  }

  async getStats(_context: Context): Promise<SessionStats> {
    return fromPi<SessionStats>((await this.read({ sessionId: this.sessionId, op: "getStats", args: {} })).stats);
  }

  close(_context: Context): Promise<void> {
    this.closing ??= this.commits.then(() => undefined);
    return this.closing;
  }

  private async read<Op extends StorageRead["op"]>(request: StorageRead & { op: Op }): Promise<Extract<StorageReadResult, { op: Op }>> {
    this.assertOpen();
    const op: Op = request.op;
    const result = await this.server.readStorage(request);
    if (!answers(result, op)) throw new Error(`Storage read ${op} answered with another op`);
    return result;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("RemoteStorage is closed");
  }
}
