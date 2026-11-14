/**
 * A session's MCP servers list (docs/features/mcp-servers.md *A session's MCP servers*): the `mcp-servers` view in the
 * Inspector, opened with `/mcp`, with two sections: the servers of the session's own checkout's `.mcp.json`, and the
 * user's own, each with a toggle. Nothing opens it by itself: an agent's prompt names the servers that are off, and
 * the agent can tell the user. It is about the session's checkout, whose file it reads: it follows the session shown
 * on that checkout, and closes with the Inspector's tabs when the user goes to another checkout.
 */

import { sameSource, type Disposer, type ReinsSdk, type Source } from "@reins/sdk";
import type { McpApi } from "@backend/extensions/mcp/api.js";
import { lockIcon, paneIcon } from "../../ui/icons.js";
import type { McpRepoServers } from "./repo-servers-list.js";
import { McpServersStore } from "./mcp-servers-store.js";
import "./repo-servers-list.js";
import "./own-servers-list.js";

type McpSdk = ReinsSdk<McpApi>;

/** The list of `source`'s `.mcp.json`, for `sessionId` (the session shown, on that checkout). */
export type McpServersView = { view: "mcp-servers"; source: Source; sessionId: string };

declare module "@reins/sdk" {
  interface ViewTypes {
    "mcp-servers": McpServersView;
  }
}

export function registerMcpSessionServers(reins: McpSdk): Disposer {
  const open = async (sessionId: string) => {
    const { source } = await reins.sessions.get(sessionId);
    reins.workspace.open({ view: "mcp-servers", source, sessionId }, { in: "inspector" });
  };
  const disposers: Disposer[] = [
    reins.commands.register({
      name: "mcp",
      description: "Show this session's MCP servers, and turn them on or off",
      run: async () => {
        const sessionId = reins.workspace.currentSubject("session");
        if (!sessionId) throw new Error("There is no session here");
        await open(sessionId);
      },
    }),
    reins.views.register("mcp-servers", {
      key: view => JSON.stringify([view.source.nodeId, view.source.path]),
      pane: {
        title: () => "MCP servers",
        description: () => "This session's MCP servers: its project's .mcp.json and your own, and which may run",
        icon: paneIcon(lockIcon),
        width: 380,
        mount(target, view) {
          const list: McpRepoServers = target.ownerDocument.createElement("mcp-repo-servers");
          list.reins = reins;
          list.sessionId = view.sessionId;
          list.setAttribute("class", "block");
          const store = new McpServersStore(reins);
          const own = target.ownerDocument.createElement("mcp-own-servers");
          own.reins = reins;
          own.store = store;
          own.setAttribute("class", "block");
          const body = target.ownerDocument.createElement("div");
          // The Inspector gives the pane a column of its height: the pane scrolls its own content.
          body.setAttribute("class", "min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 space-y-5");
          body.append(list, own);
          target.append(body);
          // A failure is the section's to show.
          void store.load();
          const show = (sessionId: string) => {
            if (sessionId === list.sessionId) return;
            list.sessionId = sessionId;
            void list.load();
          };
          // Another session on the same checkout reads the same file: the list acts for the one shown.
          const follow = reins.workspace.onDidChange(() => {
            const sessionId = reins.workspace.currentSubject("session");
            if (!sessionId || sessionId === list.sessionId) return;
            reins.sessions.get(sessionId).then(session => {
              if (sameSource(session.source, view.source) && reins.workspace.currentSubject("session") === sessionId) show(sessionId);
            }, () => undefined);
          });
          return {
            update(next) { show(next.sessionId); },
            dispose() { follow(); body.remove(); store.dispose(); },
          };
        },
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
