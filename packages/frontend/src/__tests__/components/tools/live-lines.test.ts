import { describe, expect, jest, test } from "bun:test";
import { LiveLines } from "../../../components/tools/live-lines.js";
import { templateToString } from "../../helpers/lit-template.js";

const lines = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

function liveLines(settings: Partial<Pick<LiveLines<string>, "preview" | "expanded">>) {
  const element = new LiveLines<string>();
  element.lines = lines;
  element.renderLine = (line, index) => `${index + 1}:${line};`;
  Object.assign(element, settings);
  return templateToString(element.render());
}

describe("live lines", () => {
  test("a growing preview shows the newest lines, below a mark for the earlier ones", () => {
    const shown = liveLines({ preview: "newest" });
    expect(shown).toContain("…");
    expect(shown).toContain("3:charlie;4:delta;5:echo;6:foxtrot;");
    expect(shown).not.toContain("bravo");
  });

  test("a settled preview shows the first lines, above a mark for the later ones", () => {
    const shown = liveLines({ preview: "first" });
    expect(shown).toContain("1:alpha;2:bravo;3:charlie;4:delta;");
    expect(shown).not.toContain("echo");
    expect(shown.indexOf("…")).toBeGreaterThan(shown.indexOf("delta"));
  });

  test("expanded, it shows every line", () => {
    expect(liveLines({ preview: "newest", expanded: true })).toContain("1:alpha;2:bravo;3:charlie;4:delta;5:echo;6:foxtrot;");
  });

  test("with no preview and not expanded, it shows nothing", () => {
    expect(liveLines({ preview: null })).toBe("");
  });

  test("when the lines stop growing, the newest ones stay while they close, then go", () => {
    jest.useFakeTimers();
    try {
      const element = new LiveLines<string>();
      element.lines = lines;
      element.renderLine = (line) => `${line};`;
      element.preview = null;
      Reflect.get(element, "willUpdate").call(element, new Map([["preview", "newest"]]));
      expect(templateToString(element.render())).toContain("foxtrot;");

      jest.advanceTimersByTime(300);
      expect(templateToString(element.render())).toBe("");
    } finally {
      jest.useRealTimers();
    }
  });
});
