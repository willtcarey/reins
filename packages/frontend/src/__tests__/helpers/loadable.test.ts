import { describe, expect, test } from "bun:test";
import { Loadable } from "../../helpers/loadable.js";

describe("Loadable", () => {
  test("creates an idle state", () => {
    expect(Loadable.idle<string>()).toMatchObject({
      status: "idle",
      data: null,
      loading: false,
      error: null,
    });
  });

  test("transitions to loading while preserving previous data", () => {
    expect(Loadable.idle<string>().asLoaded("previous").asLoading()).toMatchObject({
      status: "loading",
      data: "previous",
      loading: true,
      error: null,
    });
  });

  test("transitions to loaded", () => {
    expect(Loadable.idle<string>().asLoaded("value")).toMatchObject({
      status: "loaded",
      data: "value",
      loading: false,
      error: null,
    });
  });

  test("transitions to error while preserving previous data", () => {
    expect(Loadable.idle<string>().asLoaded("previous").asError("boom")).toMatchObject({
      status: "error",
      data: "previous",
      loading: false,
      error: "boom",
    });
  });
});
