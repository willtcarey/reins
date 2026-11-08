/**
 * The automations extension for tests: registered as the server registers it, on a fake clock the test moves,
 * with a scheduler that ticks once when it starts (as at the server's startup) and then only when the test calls
 * `tick`.
 */

import type { BuiltInBackendPart } from "../../extension-system/extensions.js";
import type { Automations } from "../../extensions/automations/automations.js";
import { automations, startAutomations } from "../../extensions/automations/index.js";

export interface TestAutomations {
  registration: BuiltInBackendPart;
  /** The fake clock's time. */
  now: Date;
  /** Sets the clock to `iso`. */
  setNow(iso: string): void;
  /** Checks what is due now, on the app that registered it last. */
  tick(): Promise<void>;
  /** The work in progress (a tick, a settlement being recorded) ended. */
  idle(): Promise<void>;
}

export function testAutomations(start: string): TestAutomations {
  let current: Automations | undefined;
  const test: TestAutomations = {
    now: new Date(start),
    registration: {
      name: "automations",
      migrations: automations.migrations,
      register: reins => {
        const started = startAutomations(reins, { now: () => test.now, pollMs: 3_600_000 });
        current = started.automations;
        return started.dispose;
      },
    },
    setNow(iso) { test.now = new Date(iso); },
    tick() {
      if (!current) throw new Error("testAutomations: no app registered it");
      return current.tick();
    },
    idle() {
      if (!current) throw new Error("testAutomations: no app registered it");
      return current.idle();
    },
  };
  return test;
}
