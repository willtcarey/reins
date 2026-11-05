import type { Activity } from "@reins/sdk";

/** The app's activity dot (`<activity-dot>`) calls unread `finished`. */
export function appActivity(activity: Activity): "running" | "finished" | null {
  return activity === "unread" ? "finished" : activity;
}
