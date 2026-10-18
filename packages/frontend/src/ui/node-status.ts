/**
 * A node's status as a colored dot: green connected, gray offline, red revoked. Settings → Nodes and the
 * project form's sources show it the same way.
 */

import { html } from "lit";
import type { NodeStatus } from "../models/stores/nodes-store.js";

const DOT_CLASSES: Record<NodeStatus, string> = {
  connected: "bg-green-500",
  offline: "bg-zinc-500",
  revoked: "bg-red-500",
};

export function nodeStatusDot(status: NodeStatus) {
  return html`<span class="w-2 h-2 rounded-full shrink-0 ${DOT_CLASSES[status]}" title=${status}></span>`;
}
