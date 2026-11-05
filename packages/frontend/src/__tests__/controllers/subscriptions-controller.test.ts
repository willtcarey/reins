import { describe, expect, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { SubscriptionsController } from "../../controllers/subscriptions-controller.js";

class Host implements ReactiveControllerHost {
  controllers: ReactiveController[] = [];
  addController(controller: ReactiveController) { this.controllers.push(controller); }
  removeController() {}
  requestUpdate() {}
  get updateComplete() { return Promise.resolve(true); }
}

describe("SubscriptionsController", () => {
  test("subscribes to its source while connected, again when the source changes, and stops on disconnect", () => {
    const host = new Host();
    let source: string | null = null;
    const log: string[] = [];
    const controller = new SubscriptionsController(host, () => source, (current) => {
      log.push(`subscribe ${current}`);
      return [() => log.push(`stop ${current}`)];
    });

    controller.hostConnected();
    source = "a";
    controller.hostUpdate();
    controller.hostUpdate();
    source = "b";
    controller.hostUpdate();
    controller.hostDisconnected();

    expect(log).toEqual(["subscribe a", "stop a", "subscribe b", "stop b"]);
  });
});
