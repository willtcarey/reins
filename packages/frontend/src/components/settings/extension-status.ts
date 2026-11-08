import type { ExtensionSummary } from "../../models/stores/extensions-store.js";
import type { StatusTone } from "../../ui/status-dot.js";

/** The color of an extension's status dot. */
export function statusTone({ status }: ExtensionSummary): StatusTone {
  if (status === "failed") return "danger";
  if (status === "loading") return "warning";
  return status === "disabled" ? "neutral" : "success";
}
