/** The server's requests to open a file (an agent's `open_file`), for the session the main area shows. */

import type { Disposer, Workspace } from "@reins/sdk";
import type { IAppClient } from "../models/ws-client.js";
import { openInBrowserEvent } from "./events.js";

/**
 * Opens the file browser at each file the server names for the session the main area shows (its `session` subject),
 * in the source the message names, by `open-in-browser` on `target`. Requests for other sessions are left: their
 * agents asked whoever shows them.
 */
export function openFilesOfShownSession(client: Pick<IAppClient, "subscribe">, workspace: Pick<Workspace, "currentSubject">, target: EventTarget): Disposer {
  return client.subscribe({
    open_file: (message) => {
      if (message.sessionId !== workspace.currentSubject("session")) return;
      const lineRange = message.startLine != null && message.endLine != null
        ? { startLine: message.startLine, endLine: message.endLine }
        : undefined;
      target.dispatchEvent(openInBrowserEvent(message.source, message.path, lineRange));
    },
  });
}
