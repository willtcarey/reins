/**
 * The SDK's `ui`: the host's dialogs for its things, so the text and the save are the same whichever
 * extension asks.
 */

import type { Sessions, Ui } from "@reins/sdk";
import type { SessionCache } from "../models/stores/session-cache.js";
import { inputDialog } from "../ui/input-dialog.js";

export class SdkUi implements Ui {
  constructor(private readonly sessionCache: SessionCache, private readonly sessions: Pick<Sessions, "setName">) {}

  async renameSession(sessionId: string): Promise<boolean> {
    // A session listed from elsewhere (Recent, from its backend part) may not be loaded yet.
    if (!this.sessionCache.get(sessionId)) await this.sessionCache.loadDetail(sessionId);
    const session = this.sessionCache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return inputDialog({
      heading: "Rename Session",
      label: "Name",
      value: session.name ?? "",
      placeholder: session.firstMessage ?? "Empty session",
      hint: "Leave blank to use the first message.",
      save: (name) => this.sessions.setName(sessionId, name || null),
    });
  }
}
