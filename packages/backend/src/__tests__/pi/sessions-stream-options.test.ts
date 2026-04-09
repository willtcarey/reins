import { describe, test, expect } from "bun:test";
import { wrapStreamFnWithCwd } from "../../pi/sessions.js";

describe("wrapStreamFnWithCwd", () => {
  test("injects cwd when stream options are missing", () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const base = (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      receivedOptions = options;
      return "ok";
    };

    const wrapped = wrapStreamFnWithCwd(base, "/tmp/project-a");
    wrapped({}, {});

    expect(receivedOptions).toEqual({ cwd: "/tmp/project-a" });
  });

  test("overrides any incoming cwd with the session cwd", () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const base = (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      receivedOptions = options;
      return "ok";
    };

    const wrapped = wrapStreamFnWithCwd(base, "/tmp/project-a");
    wrapped({}, {}, { cwd: "/tmp/other", signal: new AbortController().signal });

    expect(receivedOptions).toMatchObject({
      cwd: "/tmp/project-a",
    });
    expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
  });
});
