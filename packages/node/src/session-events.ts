import { contentImages, imageReference, mapContentImages, type AgentRuntimeEvent } from "@reins/node-protocol";

const IMAGE_UNAVAILABLE = { type: "text", text: "[Image attachment unavailable]" } as const;
/** Events whose payload can hold image blocks: message snapshots (user prompts, tool results) and tool
 * results, partial ones included. Streaming assistant updates (`message_update`) hold only text,
 * thinking and tool calls, so the per-token events skip the scan. */
const MAY_CARRY_IMAGES: ReadonlySet<AgentRuntimeEvent["type"]> = new Set([
  "message_start", "message_end", "turn_end", "agent_end", "entry_added", "tool_execution_update", "tool_execution_end",
]);
const isReference = (block: unknown) => imageReference.safeParse(block).success;

/** The `session.event` payload: the event serialized once, with no image bytes. Committed tool-result
 * images are already references (see `runtime/tool-images.ts`); an image still inline in a live event
 * (a partial tool result, or Pi's in-memory copy of a result its storage adapter converted on commit),
 * or any other image that is not a valid reference, is replaced by a placeholder in that event only.
 * The server relays the string without reading it, so this is the only guard against image bytes
 * reaching browsers in events. */
export function sendableEvent(event: AgentRuntimeEvent): string {
  if (!MAY_CARRY_IMAGES.has(event.type) || contentImages(event).every(isReference)) return JSON.stringify(event);
  return JSON.stringify(mapContentImages(event, block => isReference(block) ? block : IMAGE_UNAVAILABLE));
}
