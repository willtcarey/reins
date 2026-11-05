/**
 * The endpoints the user configured (`endpoints`, in the extension's database) and their API keys, in the
 * host's secret storage under `endpoints/<id>/api_key`. A key is deleted before its row, so none is left
 * behind it.
 */

import type { Static } from "@sinclair/typebox";
import type { Database, SecretStorage } from "@reins/sdk/server";
import type { EndpointChangesSchema, EndpointInputSchema, EndpointViewSchema } from "./api.js";

export type EndpointInput = Static<typeof EndpointInputSchema>;
export type EndpointChanges = Static<typeof EndpointChangesSchema>;
export type EndpointView = Static<typeof EndpointViewSchema>;

/** An endpoint as requests need it. */
export interface Endpoint extends EndpointView { apiKey: string | undefined }

/** An error the host answers with its status and `{ error }`. */
export class EndpointError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MODEL_ID = /^\S{1,150}$/;
const keyOf = (id: number) => `endpoints/${id}/api_key`;

interface Row { id: number; name: string; base_url: string; models: string | null; default_parameters: string; random_seed: number; created_at: string; updated_at: string }

/** What a schema cannot say: an http(s) URL, and model IDs that fit in an agent's model ID. */
function check(fields: { baseUrl?: string; models?: string[] | null }): void {
  if (fields.baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(fields.baseUrl);
    } catch {
      throw new EndpointError(400, "The base URL is not a URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new EndpointError(400, "The base URL must be http or https");
  }
  const bad = fields.models?.find(model => !MODEL_ID.test(model));
  if (bad !== undefined) throw new EndpointError(400, `Not a model ID: "${bad}" (no whitespace, at most 150 characters)`);
}

export class Endpoints {
  constructor(private readonly db: Database, private readonly secrets: SecretStorage) {}

  async list(): Promise<EndpointView[]> {
    const keys = new Set(await this.secrets.keys("endpoints/"));
    return this.db.query<Row, []>("SELECT * FROM endpoints ORDER BY name").all().map(row => view(row, keys.has(keyOf(row.id))));
  }

  async get(id: number): Promise<EndpointView> {
    const row = this.row(id);
    return view(row, (await this.secrets.get(keyOf(id))) !== undefined);
  }

  /** The endpoint with its API key, for requests; null for none of that name. */
  async byName(name: string): Promise<Endpoint | null> {
    const row = this.db.query<Row, [string]>("SELECT * FROM endpoints WHERE name = ?").get(name);
    return row ? this.withKey(row) : null;
  }

  /** Every endpoint with its API key, for requests. */
  async all(): Promise<Endpoint[]> {
    return Promise.all(this.db.query<Row, []>("SELECT * FROM endpoints ORDER BY name").all().map(row => this.withKey(row)));
  }

  async withKeyOf(id: number): Promise<Endpoint> {
    return this.withKey(this.row(id));
  }

  private async withKey(row: Row): Promise<Endpoint> {
    const apiKey = await this.secrets.get(keyOf(row.id));
    return { ...view(row, apiKey !== undefined), apiKey };
  }

  private row(id: number): Row {
    const row = this.db.query<Row, [number]>("SELECT * FROM endpoints WHERE id = ?").get(id);
    if (!row) throw new EndpointError(404, `Endpoint not found: ${id}`);
    return row;
  }

  async add(input: EndpointInput): Promise<EndpointView> {
    check(input);
    this.assertNameFree(input.name);
    const { id } = this.db.query<{ id: number }, [string, string, string | null, string, number]>(
      "INSERT INTO endpoints (name, base_url, models, default_parameters, random_seed) VALUES (?, ?, ?, ?, ?) RETURNING id",
    ).get(input.name, input.baseUrl, input.models ? JSON.stringify(input.models) : null, JSON.stringify(input.defaultParameters ?? {}), input.randomSeed ? 1 : 0)!;
    if (input.apiKey) {
      try {
        await this.secrets.set(keyOf(id), input.apiKey);
      } catch (error) {
        this.db.query("DELETE FROM endpoints WHERE id = ?").run(id);
        throw error;
      }
    }
    return this.get(id);
  }

  async update(id: number, changes: EndpointChanges): Promise<EndpointView> {
    const current = await this.get(id);
    check(changes);
    if (changes.name !== undefined && changes.name !== current.name) this.assertNameFree(changes.name);
    const next = {
      name: changes.name ?? current.name,
      baseUrl: changes.baseUrl ?? current.baseUrl,
      models: changes.models === undefined ? current.models : changes.models,
      defaultParameters: changes.defaultParameters ?? current.defaultParameters,
      randomSeed: changes.randomSeed ?? current.randomSeed,
    };
    this.db.query(`UPDATE endpoints SET name = ?, base_url = ?, models = ?, default_parameters = ?, random_seed = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(next.name, next.baseUrl, next.models ? JSON.stringify(next.models) : null, JSON.stringify(next.defaultParameters), next.randomSeed ? 1 : 0, id);
    if (changes.apiKey === null) await this.secrets.delete(keyOf(id));
    else if (changes.apiKey) await this.secrets.set(keyOf(id), changes.apiKey);
    return this.get(id);
  }

  async remove(id: number): Promise<void> {
    this.row(id);
    await this.secrets.delete(keyOf(id));
    this.db.query("DELETE FROM endpoints WHERE id = ?").run(id);
  }

  private assertNameFree(name: string): void {
    if (this.db.query("SELECT 1 FROM endpoints WHERE name = ?").get(name)) throw new EndpointError(409, `An endpoint is already named ${name}`);
  }
}

function view(row: Row, hasApiKey: boolean): EndpointView {
  return {
    id: row.id, name: row.name, baseUrl: row.base_url, hasApiKey,
    models: row.models === null ? null : JSON.parse(row.models),
    defaultParameters: JSON.parse(row.default_parameters),
    randomSeed: row.random_seed === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
