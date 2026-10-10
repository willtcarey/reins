/**
 * Models
 *
 * The models an entry point works with, built from the server state: a route's request (`ctx.models`),
 * a WS message, a script or tool call, the node hub. It holds nothing but the models it built (each on
 * first use, then reused within it), so one is cheap to build per request or message.
 */

import type { ServerState } from "../state.js";
import { createBroadcast, type Broadcast } from "./broadcast.js";
import { Nodes } from "./nodes.js";
import { ProjectModel } from "./projects.js";
import { Sessions } from "./sessions.js";
import { resolveSource, SourceModel } from "./sources.js";

export class Models {
  private built: { broadcast?: Broadcast; nodes?: Nodes; sessions?: Sessions } = {};

  constructor(private readonly state: ServerState) {}

  /** Sends to every browser client of the state. */
  get broadcast(): Broadcast {
    return this.built.broadcast ??= createBroadcast(this.state.clients);
  }

  get nodes(): Nodes {
    return this.built.nodes ??= new Nodes(this.state.nodes, this.broadcast);
  }

  get sessions(): Sessions {
    return this.built.sessions ??= new Sessions(this.state.nodes, this.broadcast);
  }

  /** The project working in source `sourceId` (`resolveSource`: by default, the project's default source);
   * throws `SourceNotFoundError` when there is no such source. */
  project(projectId: number, sourceId?: number | null): ProjectModel {
    return new ProjectModel(projectId, this.broadcast, new SourceModel(this.state.nodes, resolveSource(projectId, sourceId)));
  }
}
