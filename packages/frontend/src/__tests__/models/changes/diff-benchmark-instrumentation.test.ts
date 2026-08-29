import { describe, expect, test } from "bun:test";
import {
  diffBenchmarkEntryName,
  measureDiffBenchmark,
} from "../../../models/changes/diff-benchmark-instrumentation.js";

describe("diff benchmark instrumentation", () => {
  test("uses stable renderer, phase, and payload version names", () => {
    expect(diffBenchmarkEntryName("virtualized", "parse", 7)).toBe(
      "reins-diff:virtualized:parse:v7",
    );
  });

  test("remains callable when development instrumentation is disabled", () => {
    let calls = 0;
    const result = measureDiffBenchmark("classic", "payload-decode", 3, () => {
      calls += 1;
      return "decoded";
    });

    expect(result).toBe("decoded");
    expect(calls).toBe(1);
  });
});
