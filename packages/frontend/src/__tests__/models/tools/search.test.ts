import { describe, expect, test } from "bun:test";
import { getSearchResultCount } from "../../../models/tools/search.js";
import type { ToolBlockData } from "../../../models/chat-state.js";

describe("getSearchResultCount", () => {
  test("prefers the tool result matchCount detail when present", () => {
    const block: ToolBlockData = {
      id: "search-1",
      name: "search",
      args: { query: "tasks" },
      status: "done",
      result: {
        content: [{ type: "text", text: "interface Api {\n  tasks: TasksApi;\n}" }],
        details: { matchCount: 7 },
      },
    };

    expect(getSearchResultCount(block)).toBe(7);
  });
});
