import { describe, expect, test } from "bun:test";
import { getPierreWorkerPoolSetup } from "../../../models/changes/pierre-worker-pool.js";

const workerFactory: () => Worker = () => new Worker("data:text/javascript,");

describe("Pierre worker pool", () => {
  test("sizes the desktop worker pool below full hardware concurrency", () => {
    const setup = getPierreWorkerPoolSetup({
      workerFactory,
      environment: { hardwareConcurrency: 8, coarsePointer: false },
    });

    expect(setup.poolOptions.poolSize).toBe(3);
    expect(setup.poolOptions.totalASTLRUCacheSize).toBe(100);
  });

  test("uses one small-cache worker on coarse pointer devices", () => {
    const setup = getPierreWorkerPoolSetup({
      workerFactory,
      environment: { hardwareConcurrency: 8, coarsePointer: true },
    });

    expect(setup.poolOptions.poolSize).toBe(1);
    expect(setup.poolOptions.totalASTLRUCacheSize).toBe(10);
  });

  test("preloads the shared language set and Shiki theme", () => {
    const setup = getPierreWorkerPoolSetup({
      workerFactory,
      environment: { hardwareConcurrency: 4, coarsePointer: false },
    });

    expect(setup.poolOptions.workerFactory).toBe(workerFactory);
    expect(setup.poolOptions.poolSize).toBe(3);
    expect(setup.poolOptions.totalASTLRUCacheSize).toBe(100);
    expect(setup.highlighterOptions.theme).toBe("github-dark");
    expect(setup.highlighterOptions.preferredHighlighter).toBe("shiki-wasm");
    expect(setup.highlighterOptions.langs).toEqual(["cpp", "css", "go", "python", "rust", "sh", "swift", "tsx", "typescript", "zig"]);
    expect("lineDiffType" in setup.highlighterOptions).toBe(false);
  });
});
