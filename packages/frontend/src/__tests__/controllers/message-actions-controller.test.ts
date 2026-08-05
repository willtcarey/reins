import { describe, expect, mock, test } from "bun:test";
import type { ReactiveControllerHost } from "lit";
import { MessageActionsController } from "../../controllers/message-actions-controller.js";

function fakeHost() {
  return {
    addController() {},
    removeController() {},
    requestUpdate: mock(() => undefined),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
}

function fakeTimers() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  return {
    callbacks,
    setTimeout(callback: () => void) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      callbacks.delete(id);
    },
  };
}

describe("MessageActionsController", () => {
  test("opens a mobile action sheet after a stationary touch long press", () => {
    const timers = fakeTimers();
    const controller = new MessageActionsController(fakeHost(), { timers });

    controller.beginTouchPress("message-1", "raw markdown", 20, 30);
    expect(controller.pressedKey).toBe("message-1");
    expect(controller.menu).toBeNull();

    [...timers.callbacks.values()][0]?.();

    expect(controller.pressedKey).toBeNull();
    expect(controller.menu).toEqual({ mode: "sheet", text: "raw markdown", x: 20, y: 30 });
  });

  test("cancels long press feedback and the action when the touch moves", () => {
    const timers = fakeTimers();
    const controller = new MessageActionsController(fakeHost(), { timers });

    controller.beginTouchPress("message-1", "raw markdown", 20, 30);
    controller.moveTouchPress(40, 30);

    expect(controller.pressedKey).toBeNull();
    expect(timers.callbacks.size).toBe(0);
    expect(controller.menu).toBeNull();
  });

  test("opens the desktop menu from context-menu and keyboard paths", () => {
    const controller = new MessageActionsController(fakeHost());

    controller.openContextMenu("raw markdown", 80, 120);
    expect(controller.menu).toEqual({ mode: "menu", text: "raw markdown", x: 80, y: 120 });

    controller.openKeyboardMenu("other markdown", { left: 12, bottom: 45 });
    expect(controller.menu).toEqual({ mode: "menu", text: "other markdown", x: 12, y: 45 });
  });

  test("copies through the shared operation and shows confirmation before closing", async () => {
    const timers = fakeTimers();
    const copyText = mock(async (_text: string) => undefined);
    const controller = new MessageActionsController(fakeHost(), { copyText, timers });
    controller.openContextMenu("**raw**", 0, 0);

    await controller.copyMarkdown();

    expect(copyText).toHaveBeenCalledWith("**raw**");
    expect(controller.copied).toBe(true);
    [...timers.callbacks.values()][0]?.();
    expect(controller.menu).toBeNull();
    expect(controller.copied).toBe(false);
  });
});
