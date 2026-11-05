/**
 * Keeps an element's subscriptions while it is on the page: `subscribe(source)` makes them when the element
 * connects (and its source is there) and again when its source changes; their disposers run when it
 * disconnects. The element says what it listens for and what to do on hearing it (usually `requestUpdate`,
 * when the change is one it shows).
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";

type Stop = () => unknown;

export class SubscriptionsController<S> implements ReactiveController {
  private stops: Stop[] = [];
  private subscribed: S | null = null;
  private connected = false;

  constructor(
    host: ReactiveControllerHost,
    private readonly source: () => S | null,
    private readonly subscribe: (source: S) => Stop[],
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connected = true;
    this.resubscribe();
  }

  hostDisconnected(): void {
    this.connected = false;
    this.stop();
  }

  hostUpdate(): void {
    if (this.source() !== this.subscribed) this.resubscribe();
  }

  private resubscribe(): void {
    this.stop();
    const source = this.source();
    if (source === null || !this.connected) return;
    this.subscribed = source;
    this.stops = this.subscribe(source);
  }

  private stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    this.subscribed = null;
  }
}
