/**
 * Requests for secrets and the secrets stored from them (docs/features/secrets.md). A request returns at once; the
 * user answers it in the form its session shows, and the session is woken with a handle for each value, never the
 * value. Whoever has a handle can read its value (`get`), so a session reads only the secrets it was given.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Database, Logger, SecretStorage, ServerSdk } from "@reins/sdk/server";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAMES = 50;
const MAX_VALUE_BYTES = 16 * 1024;
/** How long a secret is kept after it was last used (or stored, when never used). */
export const KEEP_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
const valueKey = (handle: string) => `values/${handle}`;

export interface RequestInput {
  names: string[];
  purpose?: string;
  descriptions?: Record<string, string>;
}

export interface OpenRequest {
  id: string;
  sessionId: string;
  purpose: string | null;
  fields: { name: string; description: string | null }[];
  createdAt: string;
}

/** A refusal the HTTP host answers with its status; a script gets its message. */
export class SecretsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SecretsError";
  }
}

export interface SecretsDependencies {
  db: Database;
  secrets: SecretStorage;
  sessions: Pick<ServerSdk["sessions"], "send">;
  broadcast(message: object): void;
  logger: Logger;
  now(): Date;
}

interface RequestRow { id: string; session_id: string; purpose: string | null; fields_json: string; created_at: string }

export class Secrets {
  /** Requests being answered now: a second browser's answer meanwhile is refused, not applied twice. */
  private readonly answering = new Set<string>();

  constructor(private readonly deps: SecretsDependencies) {}

  request(sessionId: string, { names, purpose, descriptions = {} }: RequestInput): { requested: string[]; next: string } {
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES) throw new SecretsError(`Ask for 1 to ${MAX_NAMES} names`);
    for (const name of names) {
      if (typeof name !== "string" || !NAME.test(name)) throw new SecretsError(`${JSON.stringify(name)}: a name must start with a letter or underscore and contain only letters, digits and underscores`);
    }
    if (new Set(names).size !== names.length) throw new SecretsError("The names must be unique");
    for (const [name, description] of Object.entries(descriptions)) {
      if (!names.includes(name)) throw new SecretsError(`A description is for ${name}, which is not asked for`);
      if (typeof description !== "string" || !description.trim()) throw new SecretsError(`The description of ${name} is blank`);
    }
    const fields = names.map(name => ({ name, description: descriptions[name]?.trim() ?? null }));
    this.deps.db.query("INSERT INTO requests (id, session_id, purpose, fields_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), sessionId, purpose?.trim() || null, JSON.stringify(fields), this.now());
    this.changed();
    return {
      requested: names,
      next: "The user is asked to enter these in a form that opens beside this session's chat. End your turn now and tell the user; " +
        "a message wakes you with a handle for each value once they answer (or that they cancelled).",
    };
  }

  open(): OpenRequest[] {
    return this.deps.db.query<RequestRow, []>("SELECT * FROM requests ORDER BY created_at, rowid").all().map(row => ({
      id: row.id, sessionId: row.session_id, purpose: row.purpose, fields: JSON.parse(row.fields_json), createdAt: row.created_at,
    }));
  }

  /**
   * Stores the values, then wakes the session with their handles; only once it is told is the request closed. A
   * session that cannot be told (its node removed) keeps the request open and nothing stored, so the user can try
   * again or cancel it.
   */
  async submit(id: string, values: Record<string, string>): Promise<void> {
    const request = this.claim(id);
    try {
      const names = request.fields.map(field => field.name);
      const given = Object.keys(values);
      if (given.length !== names.length || !names.every(name => Object.hasOwn(values, name))) throw new SecretsError(`Give exactly ${names.join(", ")}`);
      if (Object.values(values).some(value => !isOneLine(value))) throw new SecretsError("Each value must be one non-empty line of at most 16 KiB");
      const stored: { name: string; handle: string }[] = [];
      try {
        for (const name of names) {
          const handle = `sec_${randomBytes(24).toString("base64url")}`;
          await this.deps.secrets.set(valueKey(handle), values[name]!);
          stored.push({ name, handle });
        }
        await this.deps.sessions.send(request.sessionId, storedMessage(stored));
      } catch (error) {
        await Promise.all(stored.map(({ handle }) => this.deps.secrets.delete(valueKey(handle))));
        throw error;
      }
      const createdAt = this.now();
      this.deps.db.transaction(() => {
        const insert = this.deps.db.query("INSERT INTO secrets (handle, name, session_id, created_at) VALUES (?, ?, ?, ?)");
        for (const { name, handle } of stored) insert.run(handle, name, request.sessionId, createdAt);
        this.deps.db.query("DELETE FROM requests WHERE id = ?").run(id);
      })();
      this.changed();
    } finally {
      this.answering.delete(id);
    }
  }

  async cancel(id: string): Promise<void> {
    const request = this.claim(id);
    try {
      const names = request.fields.map(field => field.name);
      await this.deps.sessions.send(request.sessionId, `The user cancelled the request for ${list(names)}: nothing was stored. Do not ask for the values in the chat.`);
      this.deps.db.query("DELETE FROM requests WHERE id = ?").run(id);
      this.changed();
    } finally {
      this.answering.delete(id);
    }
  }

  async get(handle: string): Promise<string> {
    const value = typeof handle === "string" && handle.startsWith("sec_") ? await this.deps.secrets.get(valueKey(handle)) : undefined;
    const known = value !== undefined && this.deps.db.query("UPDATE secrets SET last_used_at = ? WHERE handle = ?").run(this.now(), handle).changes > 0;
    if (!known) throw new SecretsError("No secret has this handle: it may have been deleted. Request it again.", 404);
    return value;
  }

  stored() {
    return this.deps.db.query<{ id: number; name: string; session_id: string; created_at: string; last_used_at: string | null }, []>(
      "SELECT id, name, session_id, created_at, last_used_at FROM secrets ORDER BY created_at DESC, id DESC",
    ).all().map(row => ({ id: row.id, name: row.name, sessionId: row.session_id, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
  }

  async remove(id: number): Promise<void> {
    const row = this.deps.db.query<{ handle: string }, [number]>("SELECT handle FROM secrets WHERE id = ?").get(id);
    if (!row) throw new SecretsError("No such secret", 404);
    await this.deletes([row.handle]);
  }

  /** Deletes the secrets not used (nor stored) within `KEEP_UNUSED_MS`. */
  async expire(): Promise<void> {
    const before = new Date(this.deps.now().getTime() - KEEP_UNUSED_MS).toISOString();
    const handles = this.deps.db.query<{ handle: string }, [string]>("SELECT handle FROM secrets WHERE COALESCE(last_used_at, created_at) < ?").all(before);
    if (handles.length > 0) await this.deletes(handles.map(row => row.handle));
  }

  /** The value first: a record without a value is shown and harmless, a value without a record could not be deleted. */
  private async deletes(handles: string[]): Promise<void> {
    for (const handle of handles) {
      await this.deps.secrets.delete(valueKey(handle));
      this.deps.db.query("DELETE FROM secrets WHERE handle = ?").run(handle);
    }
    this.changed();
  }

  private claim(id: string): OpenRequest {
    const request = this.open().find(candidate => candidate.id === id);
    if (!request || this.answering.has(id)) throw new SecretsError("This request has ended", 404);
    this.answering.add(id);
    return request;
  }

  private now(): string {
    return this.deps.now().toISOString();
  }

  private changed(): void {
    this.deps.broadcast({ type: "changed" });
  }
}

function isOneLine(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !["\r", "\n", "\0"].some(character => value.includes(character)) && new TextEncoder().encode(value).byteLength <= MAX_VALUE_BYTES;
}

const list = (names: readonly string[]) => names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Visible: what the user did. Hidden: the handles and how to use them, which only the model needs. */
function storedMessage(stored: { name: string; handle: string }[]) {
  return [
    `The user entered ${list(stored.map(({ name }) => name))}.`,
    {
      hidden: true,
      label: "Secret handles",
      text:
        `Each value is stored under a handle:\n${stored.map(({ name, handle }) => `- ${name}: ${handle}`).join("\n")}\n\n` +
        "In an execute script, read a value with `await reins.secrets.get(handle)` and give it to a command as an environment variable, " +
        "never in the command's text: " +
        "`reins.nodes.run(\"current\", 'printf \"%s\\n\" \"KEY=$KEY\" >> .env', { cwd, env: { KEY: value } })` (it gives `{ exitCode, output }`). " +
        "Never return a value from the script, print it, write it into a message or read back a file that holds it. " +
        "A handle stops working 7 days after its last use.",
    },
  ];
}
