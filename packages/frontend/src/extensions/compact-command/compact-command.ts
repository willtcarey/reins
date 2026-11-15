/** The built-in `/compact` command, registered through the SDK as an extension's would be. */

import type { Disposer, ReinsSdk } from "@reins/sdk";
import { compactIcon, paneIcon } from "../../ui/icons.js";

export function registerCompactCommand(reins: ReinsSdk): Disposer {
  return reins.commands.register({
    name: "compact",
    title: "Compact",
    icon: paneIcon(compactIcon),
    available: () => reins.workspace.currentSubject("session") !== null,
    description: "Summarize the conversation so far to free its context; text after it focuses the summary",
    run: ({ args }) => {
      const sessionId = reins.workspace.currentSubject("session");
      if (!sessionId) throw new Error("There is no session here to compact");
      return reins.sessions.compact(sessionId, args || undefined);
    },
  });
}
