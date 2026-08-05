import type { ReactiveController, ReactiveControllerHost } from "lit";
import { copyTextToClipboard } from "../helpers/clipboard.js";

const LONG_PRESS_MS = 500;
const COPY_FEEDBACK_MS = 700;
const MOVE_TOLERANCE_PX = 10;

type TimerId = number;

interface TimerOperations {
  setTimeout(callback: () => void, delay: number): TimerId;
  clearTimeout(id: TimerId): void;
}

interface MessageActionsOptions {
  copyText?: (text: string) => Promise<void>;
  timers?: TimerOperations;
}

export interface MessageActionMenu {
  mode: "sheet" | "menu";
  text: string;
  x: number;
  y: number;
}

const browserTimers: TimerOperations = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (id) => window.clearTimeout(id),
};

/** Owns transient message press, menu, and copy-confirmation state. */
export class MessageActionsController implements ReactiveController {
  pressedKey: string | null = null;
  menu: MessageActionMenu | null = null;
  copied = false;

  private readonly copyText: (text: string) => Promise<void>;
  private readonly timers: TimerOperations;
  private pressStart: { x: number; y: number } | null = null;
  private pressTimer: TimerId | null = null;
  private feedbackTimer: TimerId | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    options: MessageActionsOptions = {},
  ) {
    host.addController(this);
    this.copyText = options.copyText ?? copyTextToClipboard;
    this.timers = options.timers ?? browserTimers;
  }

  hostDisconnected() {
    this.clearPress();
    this.clearFeedbackTimer();
  }

  beginTouchPress(key: string, text: string, x: number, y: number) {
    this.clearPress();
    this.close();
    this.pressedKey = key;
    this.pressStart = { x, y };
    this.pressTimer = this.timers.setTimeout(() => {
      this.pressTimer = null;
      this.pressStart = null;
      this.pressedKey = null;
      this.menu = { mode: "sheet", text, x, y };
      this.host.requestUpdate();
    }, LONG_PRESS_MS);
    this.host.requestUpdate();
  }

  moveTouchPress(x: number, y: number) {
    if (!this.pressStart) return;
    if (
      Math.abs(x - this.pressStart.x) > MOVE_TOLERANCE_PX
      || Math.abs(y - this.pressStart.y) > MOVE_TOLERANCE_PX
    ) {
      this.clearPress();
      this.host.requestUpdate();
    }
  }

  endTouchPress() {
    if (!this.pressStart && !this.pressTimer) return;
    this.clearPress();
    this.host.requestUpdate();
  }

  openActionSheet(text: string, x: number, y: number) {
    this.clearPress();
    this.copied = false;
    this.menu = { mode: "sheet", text, x, y };
    this.host.requestUpdate();
  }

  openContextMenu(text: string, x: number, y: number) {
    this.clearPress();
    this.copied = false;
    this.menu = { mode: "menu", text, x, y };
    this.host.requestUpdate();
  }

  openKeyboardMenu(text: string, anchor: { left: number; bottom: number }) {
    this.openContextMenu(text, anchor.left, anchor.bottom);
  }

  close() {
    this.clearFeedbackTimer();
    this.menu = null;
    this.copied = false;
    this.host.requestUpdate();
  }

  async copyMarkdown() {
    if (!this.menu) return;
    await this.copyText(this.menu.text);
    this.copied = true;
    this.clearFeedbackTimer();
    this.feedbackTimer = this.timers.setTimeout(() => this.close(), COPY_FEEDBACK_MS);
    this.host.requestUpdate();
  }

  private clearPress() {
    if (this.pressTimer !== null) this.timers.clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.pressStart = null;
    this.pressedKey = null;
  }

  private clearFeedbackTimer() {
    if (this.feedbackTimer !== null) this.timers.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
  }
}
