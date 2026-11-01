/**
 * A node's status as a colored dot: green connected, gray offline, red revoked. Settings → Nodes and the
 * project form's sources show it the same way. Here, not in `ui/`: it knows nodes.
 */

import type { NodeStatus } from "../models/stores/nodes-store.js";
import { statusDot, type StatusTone } from "../ui/status-dot.js";

const TONES: Record<NodeStatus, StatusTone> = {
  connected: "success",
  offline: "neutral",
  revoked: "danger",
};

export function nodeStatusDot(status: NodeStatus) {
  return statusDot(TONES[status], { label: status });
}
