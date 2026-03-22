/**
 * Tests for StoreController — generic reactive controller that subscribes
 * to any store with a subscribe/unsubscribe pattern and triggers host updates.
 */
import { describe, test, expect } from "bun:test";
import { StoreController } from "../controllers/store-controller.js";
import type { Subscribable } from "../controllers/store-controller.js";
import type { ReactiveControllerHost, ReactiveController } from "lit";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal fake store with manual notify. */
function fakeStore(): Subscribable & { notify(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify() {
      for (const fn of listeners) fn();
    },
  };
}

/** Fake host that tracks requestUpdate calls and controllers. */
function fakeHost() {
  const controllers: ReactiveController[] = [];
  let updateCount = 0;
  return {
    addController(c: ReactiveController) { controllers.push(c); },
    removeController(c: ReactiveController) {
      const i = controllers.indexOf(c);
      if (i >= 0) controllers.splice(i, 1);
    },
    requestUpdate() { updateCount++; },
    updateComplete: Promise.resolve(true),
    // Test helpers
    get updateCount() { return updateCount; },
    get controllers() { return controllers; },
    /** Simulate Lit disconnecting the component. */
    disconnect() {
      for (const c of Array.from(controllers)) c.hostDisconnected?.();
    },
    /** Simulate Lit reconnecting the component. */
    connect() {
      for (const c of Array.from(controllers)) c.hostConnected?.();
    },
  } satisfies ReactiveControllerHost & {
    updateCount: number;
    controllers: ReactiveController[];
    disconnect(): void;
    connect(): void;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StoreController", () => {
  test("registers itself with the host", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    expect(host.controllers).toContain(ctrl);
  });

  test("store is null initially", () => {
    const ctrl = new StoreController(fakeHost());
    expect(ctrl.store).toBeNull();
  });

  test("setting store subscribes and triggers host update on notify", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const store = fakeStore();

    ctrl.store = store;

    expect(host.updateCount).toBe(0);
    store.notify();
    expect(host.updateCount).toBe(1);
    store.notify();
    expect(host.updateCount).toBe(2);
  });

  test("setting same store is a no-op", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const store = fakeStore();

    ctrl.store = store;
    ctrl.store = store; // same reference

    // Should still only have one subscription — verify by notifying
    store.notify();
    expect(host.updateCount).toBe(1); // not 2
  });

  test("changing store unsubscribes from old, subscribes to new", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const storeA = fakeStore();
    const storeB = fakeStore();

    ctrl.store = storeA;
    ctrl.store = storeB;

    storeA.notify(); // should NOT trigger update (unsubscribed)
    expect(host.updateCount).toBe(0);

    storeB.notify(); // should trigger update
    expect(host.updateCount).toBe(1);
  });

  test("setting store to null unsubscribes", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const store = fakeStore();

    ctrl.store = store;
    ctrl.store = null;

    store.notify();
    expect(host.updateCount).toBe(0);
  });

  test("hostDisconnected unsubscribes", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const store = fakeStore();

    ctrl.store = store;
    host.disconnect();

    store.notify();
    expect(host.updateCount).toBe(0);
  });

  test("hostConnected re-subscribes after disconnect", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const store = fakeStore();

    ctrl.store = store;
    host.disconnect();
    host.connect();

    store.notify();
    expect(host.updateCount).toBe(1);
  });

  test("disconnect + connect does not double-subscribe", () => {
    const host = fakeHost();
    const ctrl = new StoreController(host);
    const store = fakeStore();

    ctrl.store = store;
    host.disconnect();
    host.connect();

    store.notify();
    expect(host.updateCount).toBe(1); // not 2
  });

  test("works with typed store generic", () => {
    interface MyStore extends Subscribable {
      data: string;
    }
    const store: MyStore = {
      ...fakeStore(),
      data: "hello",
    };

    const host = fakeHost();
    const ctrl = new StoreController<MyStore>(host);
    ctrl.store = store;

    // Type-safe access
    expect(ctrl.store!.data).toBe("hello");
  });

  test("hostDisconnected without a store is safe", () => {
    const host = fakeHost();
    new StoreController(host);
    expect(() => host.disconnect()).not.toThrow();
  });

  test("hostConnected without a store is safe", () => {
    const host = fakeHost();
    new StoreController(host);
    expect(() => host.connect()).not.toThrow();
  });
});
