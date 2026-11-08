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
import type { ExtensionHost } from "../extension-system/host.js";
import { Nodes } from "./nodes.js";
import { ProjectModel, Projects } from "./projects.js";
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

  /** What the app's extensions registered (`reins.tools`, their script functions, prompt sections, routes). */
  get extensions(): ExtensionHost {
    return this.state.extensions.host;
  }

  get nodes(): Nodes {
    return this.built.nodes ??= new Nodes(this.state, this.broadcast);
  }

  /** Making, changing and deleting projects. */
  get projects(): Projects {
    return new Projects(this.nodes);
  }

  get sessions(): Sessions {
    return this.built.sessions ??= new Sessions(this.state, this.broadcast);
  }

  /** Project `projectId` (`ProjectModel`); throws `SourceNotFoundError` when it has no default source. */
  project(projectId: number): ProjectModel {
    return new ProjectModel(projectId, this.nodes);
  }

  /** Source `sourceId` (`resolveSource`; throws `SourceNotFoundError`), on this app's nodes. */
  source(sourceId: number): SourceModel {
    return new SourceModel(this.state.nodes, resolveSource(sourceId));
  }
}
