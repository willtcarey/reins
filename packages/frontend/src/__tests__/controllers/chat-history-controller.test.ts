import { describe, expect, mock, test } from "bun:test";
import type { ReactiveControllerHost } from "lit";
import { ChatHistoryController } from "../../controllers/chat-history-controller.js";

describe("ChatHistoryController", () => {
  test("preserves the visible message position when earlier history is prepended", async () => {
    let finishLoad!: (loaded: boolean) => void;
    const loadPrevious = mock(() => new Promise<boolean>((resolve) => { finishLoad = resolve; }));
    const requestUpdate = mock(() => undefined);
    const host: ReactiveControllerHost = {
      addController: mock(() => undefined),
      removeController: mock(() => undefined),
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };

    let anchorBottom = 300;
    const anchor = {
      getAttribute: (name: string) => name === "data-conversation-key" ? "message-2" : null,
      getBoundingClientRect: () => ({ bottom: anchorBottom }),
    };
    let scrollHeight = 1_000;
    const container: Parameters<ChatHistoryController["loadPrevious"]>[0] = {
      clientHeight: 600,
      get scrollHeight() { return scrollHeight; },
      scrollTop: 20,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
      querySelectorAll: () => [anchor],
    };
    const controller = new ChatHistoryController(host, {
      hasEarlierMessages: () => true,
      loadPrevious,
    });

    const loading = controller.loadPrevious(container);
    expect(controller.loading).toBe(true);
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    // Keep a user scroll made while the request is in flight, then simulate
    // the anchor moving down when the prepended records render.
    container.scrollTop = 40;
    controller.handleScroll(container);
    scrollHeight = 1_200;
    anchorBottom = 500;
    finishLoad(true);
    await loading;

    expect(container.scrollTop).toBe(260);
    expect(controller.loading).toBe(false);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });
});
