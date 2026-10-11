import { expect, test } from "bun:test";
import { bunTarget } from "./bun.js";

test("Bun's release for a machine is the one its own installer picks", () => {
  const machine = { platform: "linux", arch: "x64", musl: false, avx2: true, rosetta: false } as const;
  expect(bunTarget(machine)).toBe("linux-x64");
  // Bun's default x64 build needs AVX2.
  expect(bunTarget({ ...machine, avx2: false })).toBe("linux-x64-baseline");
  expect(bunTarget({ ...machine, musl: true, avx2: false })).toBe("linux-x64-musl-baseline");
  expect(bunTarget({ ...machine, arch: "arm64", musl: true })).toBe("linux-aarch64-musl");
  expect(bunTarget({ ...machine, platform: "darwin" })).toBe("darwin-x64");
  // A Bun under Rosetta on Apple silicon: the native build.
  expect(bunTarget({ ...machine, platform: "darwin", rosetta: true })).toBe("darwin-aarch64");
  expect(() => bunTarget({ ...machine, platform: "win32" })).toThrow("Reins nodes run on Linux and macOS, not win32");
});
