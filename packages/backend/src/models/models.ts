/**
 * Models
 *
 * The models an entry point works with, built from the app's state: a route's request (`ctx.models`),
 * a WS message, a script or tool call, the node hub. It holds nothing but the models it built (each on
 * first use, then reused within it), so one is cheap to build per request or message.
 */

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { AppState } from "../state.js";
import { createDbCredentialStore } from "../pi/credential-store.js";
import { createBroadcast, type Broadcast } from "./broadcast.js";
import { Nodes } from "./nodes.js";
import { ProjectModel } from "./projects.js";
import { Sessions } from "./sessions.js";
import { resolveSource, SourceModel } from "./sources.js";

export class Models {
  private built: { broadcast?: Broadcast; credentials?: CredentialStore; nodes?: Nodes; sessions?: Sessions } = {};

  constructor(private readonly state: AppState) {}

  /** Sends to every browser connection of the process. */
  get broadcast(): Broadcast {
    return this.built.broadcast ??= createBroadcast(this.state.process);
  }

  /** The server's credential store, under the process's per-provider lock (the model catalog's and OAuth
   * logins' credentials). */
  get credentials(): CredentialStore {
    return this.built.credentials ??= createDbCredentialStore(this.state.process);
  }

  get nodes(): Nodes {
    return this.built.nodes ??= new Nodes(this.state, this.broadcast);
  }

  get sessions(): Sessions {
    return this.built.sessions ??= new Sessions(this.state, this.broadcast);
  }

  /** The project working in source `sourceId` (`resolveSource`: by default, the project's default source);
   * throws `SourceNotFoundError` when there is no such source. */
  project(projectId: number, sourceId?: number | null): ProjectModel {
    return new ProjectModel(projectId, this.broadcast, new SourceModel(this.state.nodes, resolveSource(projectId, sourceId)));
  }
}
