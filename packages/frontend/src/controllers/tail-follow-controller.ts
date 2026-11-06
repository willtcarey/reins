import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Keeps a growing scroll box at its end while its host says it grows (a running command's output, a file
 * being written), until the user scrolls up in it; scrolling back to the end follows again. Bind `onScroll`
 * as the box's `@scroll` listener.
 */
export class TailFollowController implements ReactiveController {
  private following = true;

  constructor(
    private host: ReactiveControllerHost & Element,
    private selector: string,
    private active: () => boolean,
  ) {
    host.addController(this);
  }

  onScroll = (event: Event) => {
    if (!this.active() || !(event.currentTarget instanceof HTMLElement)) return;
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    this.following = scrollTop + clientHeight >= scrollHeight - 8;
  };

  hostUpdated() {
    if (!this.active() || !this.following) return;
    const box = this.host.querySelector<HTMLElement>(this.selector);
    if (box) box.scrollTop = box.scrollHeight;
  }
}
