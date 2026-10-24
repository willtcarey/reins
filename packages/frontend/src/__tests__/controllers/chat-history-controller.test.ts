import { describe, expect, mock, test } from "bun:test";
import type { ReactiveControllerHost } from "lit";
import { ChatHistoryController } from "../../controllers/chat-history-controller.js";

function history() {
  let finishLoad!: (loaded: boolean) => void;
  const loadPrevious = mock(() => new Promise<boolean>((resolve) => { finishLoad = resolve; }));
  const host: ReactiveControllerHost = {
    addController: mock(() => undefined),
    removeController: mock(() => undefined),
    requestUpdate: mock(() => undefined),
    updateComplete: Promise.resolve(true),
  };
  const events: string[] = [];
  const anchor = {
    pin: () => {
      events.push("pin");
      return () => { events.push("release"); };
    },
    restore: () => { events.push("restore"); },
  };
  const controller = new ChatHistoryController(host, { hasEarlierMessages: () => true, loadPrevious, anchor });
  return { controller, events, loadPrevious, finish: (loaded: boolean) => finishLoad(loaded) };
}

describe("ChatHistoryController", () => {
  test("pins the scroll anchor while earlier history loads, and restores it once rendered", async () => {
    const { controller, events, loadPrevious, finish } = history();

    const loading = controller.loadPrevious();
    expect(controller.loading).toBe(true);
    expect(loadPrevious).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["pin"]);
    finish(true);
    await loading;

    expect(events).toEqual(["pin", "restore", "release"]);
    expect(controller.loading).toBe(false);
  });

  test("releases the anchor without restoring it when nothing loaded, or when reset during a load", async () => {
    const { controller, events, finish } = history();

    const empty = controller.loadPrevious();
    finish(false);
    await empty;
    expect(events).toEqual(["pin", "release"]);

    const reset = controller.loadPrevious();
    controller.reset();
    finish(true);
    await reset;
    expect(events).toEqual(["pin", "release", "pin", "release"]);
  });
});
