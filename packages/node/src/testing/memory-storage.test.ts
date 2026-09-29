import { test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { MemoryStorage } from "./memory-storage.js";

// The test double meets Pi's own Storage contract, as the server's storage does.
for (const testCase of createStorageConformance(async () => {
  const storage = new MemoryStorage();
  return { storage, [Symbol.asyncDispose]: () => storage.close(BACKGROUND_CONTEXT) };
})) test(`MemoryStorage: ${testCase.group}: ${testCase.name}`, testCase.run);
