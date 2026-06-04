import { createBroadcast } from "../models/broadcast.js";
import type { AgentRuntime } from "./registry.js";
import { externalizeRuntimeEventImages } from "./runtime-image-externalization.js";

export function attachRuntimeBroadcastObserver(params: {
  sessionId: string;
  projectId: number;
  runtime: AgentRuntime;
  clients: Parameters<typeof createBroadcast>[0];
}): () => void {
  const { sessionId, projectId, runtime, clients } = params;
  const broadcast = createBroadcast(clients);

  return runtime.subscribe((event) => {
    broadcast({
      type: "event",
      sessionId,
      projectId,
      event: externalizeRuntimeEventImages(sessionId, event),
    });
  });
}
