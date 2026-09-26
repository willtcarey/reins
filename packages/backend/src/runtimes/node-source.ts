import { getSource, internalSource, type Source } from "../node-store.js";
export function selectCreationSource(projectId: number, sourceId?: number): Source {
  const source = sourceId === undefined ? internalSource(projectId) : getSource(sourceId);
  if (!source || source.project_id !== projectId) throw new Error(`Execution source unavailable for project ${projectId}`);
  // Selection is server policy, not a live connectivity check. Unavailable
  // sources may retain queued creation; the dispatcher never sends to them.
  return source;
}
