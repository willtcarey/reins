/**
 * The openai-images Settings page's state: the endpoints, adding, changing, removing and testing them over the
 * extension's HTTP API. Its backend part sends no messages, so the list changes only by what this page does,
 * and is listed again when the connection comes back. An API key is only ever written.
 */

import type { OpenAiImagesApi } from "@backend/extensions/openai-images/api.js";
import type { Http, HttpOutput, ReinsSdk } from "@reins/sdk";
import { Loadable } from "../../helpers/loadable.js";

export type EndpointView = HttpOutput<OpenAiImagesApi["add"]>;
export type EndpointsStoreResult = { ok: true } | { error: string };

/** The add/edit form's fields. A blank API key keeps the endpoint's (none for a new one). */
export interface EndpointDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Model IDs, one a line or separated by commas; blank: every model the server lists. */
  models: string;
  /** A JSON object; blank: none. */
  defaultParameters: string;
  randomSeed: boolean;
}

export function emptyDraft(): EndpointDraft {
  return { name: "", baseUrl: "", apiKey: "", models: "", defaultParameters: "", randomSeed: false };
}

export function draftOf(endpoint: EndpointView): EndpointDraft {
  const parameters = Object.keys(endpoint.defaultParameters).length > 0 ? JSON.stringify(endpoint.defaultParameters, null, 2) : "";
  return { name: endpoint.name, baseUrl: endpoint.baseUrl, apiKey: "", models: endpoint.models?.join("\n") ?? "", defaultParameters: parameters, randomSeed: endpoint.randomSeed };
}

/** What the form sends; an Error for default parameters that are not a JSON object. */
export function draftRequest(draft: EndpointDraft) {
  let defaultParameters: Record<string, unknown> = {};
  if (draft.defaultParameters.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.defaultParameters);
    } catch {
      throw new Error("Default parameters are not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Default parameters must be a JSON object");
    defaultParameters = Object.fromEntries(Object.entries(parsed));
  }
  const models = draft.models.split(/[\n,]/).map(model => model.trim()).filter(Boolean);
  return {
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    models: models.length > 0 ? models : null,
    defaultParameters,
    randomSeed: draft.randomSeed,
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };
}

export type EndpointAction = "saving" | "testing" | "removing";

const byName = (a: EndpointView, b: EndpointView) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export class EndpointsStore {
  endpoints: Loadable<EndpointView[]> = Loadable.idle();
  /** What is in progress for each endpoint. */
  actions = new Map<number, EndpointAction>();
  /** The last test of each endpoint: the models the server listed, or why it failed. */
  tests = new Map<number, { models: string[] } | { error: string }>();
  creating = false;

  private _listeners = new Set<() => void>();
  private _unsubscribe: Array<() => void>;
  private readonly _http: Http<OpenAiImagesApi>;

  constructor(reins: Pick<ReinsSdk<OpenAiImagesApi>, "http" | "onReconnect">) {
    this._http = reins.http;
    this._unsubscribe = [reins.onReconnect(() => { if (this.endpoints.status !== "idle") void this.load(); })];
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose() {
    for (const unsubscribe of this._unsubscribe.splice(0)) unsubscribe();
  }

  async load(): Promise<EndpointsStoreResult> {
    this.endpoints = this.endpoints.asLoading();
    this.notify();
    try {
      this.endpoints = this.endpoints.asLoaded(await this._http.call("list"));
      return { ok: true };
    } catch (err: unknown) {
      const error = errorMessage(err);
      this.endpoints = this.endpoints.asError(error);
      return { error };
    } finally {
      this.notify();
    }
  }

  async create(draft: EndpointDraft): Promise<EndpointsStoreResult> {
    this.creating = true;
    this.notify();
    try {
      this._upsert(await this._http.call("add", draftRequest(draft)));
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.creating = false;
      this.notify();
    }
  }

  update(id: number, draft: EndpointDraft): Promise<EndpointsStoreResult> {
    return this._act(id, "saving", async () => this._upsert(await this._http.call("update", { id, changes: draftRequest(draft) })));
  }

  /** Removes the endpoint's API key. */
  clearApiKey(id: number): Promise<EndpointsStoreResult> {
    return this._act(id, "saving", async () => this._upsert(await this._http.call("update", { id, changes: { apiKey: null } })));
  }

  /** Asks the server for its models; the answer or the failure is kept in `tests`. */
  test(id: number): Promise<EndpointsStoreResult> {
    this.tests.delete(id);
    return this._act(id, "testing", async () => {
      try {
        this.tests.set(id, await this._http.call("test", { id }));
      } catch (err: unknown) {
        this.tests.set(id, { error: errorMessage(err) });
      }
    });
  }

  remove(id: number): Promise<EndpointsStoreResult> {
    return this._act(id, "removing", async () => {
      await this._http.call("remove", { id });
      const endpoints = this.endpoints.data;
      if (endpoints) this.endpoints = this.endpoints.asLoaded(endpoints.filter(endpoint => endpoint.id !== id));
      this.tests.delete(id);
    });
  }

  private async _act(id: number, action: EndpointAction, work: () => Promise<void>): Promise<EndpointsStoreResult> {
    this.actions.set(id, action);
    this.notify();
    try {
      await work();
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.actions.delete(id);
      this.notify();
    }
  }

  /** Nothing is listed before the first load. */
  private _upsert(endpoint: EndpointView) {
    const endpoints = this.endpoints.data;
    if (!endpoints) return;
    this.endpoints = this.endpoints.asLoaded([...endpoints.filter(e => e.id !== endpoint.id), endpoint].toSorted(byName));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
