import { describe, expect, mock, test } from "bun:test";
import { copyTextToClipboard } from "../../helpers/clipboard.js";

describe("copyTextToClipboard", () => {
  test("uses the Clipboard API when available", async () => {
    const writeText = mock(async (_text: string) => {});
    const fallbackCopy = mock((_text: string) => true);

    await copyTextToClipboard("session-123", { writeText, fallbackCopy });

    expect(writeText).toHaveBeenCalledWith("session-123");
    expect(fallbackCopy).toHaveBeenCalledTimes(0);
  });

  test("uses the fallback when the Clipboard API fails", async () => {
    const writeText = mock(async (_text: string) => { throw new Error("insecure context"); });
    const fallbackCopy = mock((_text: string) => true);

    await copyTextToClipboard("session-123", { writeText, fallbackCopy });

    expect(fallbackCopy).toHaveBeenCalledWith("session-123");
  });

  test("rejects when neither clipboard strategy succeeds", async () => {
    const fallbackCopy = mock((_text: string) => false);

    expect(copyTextToClipboard("session-123", { fallbackCopy })).rejects.toThrow("Could not copy text");
  });
});
