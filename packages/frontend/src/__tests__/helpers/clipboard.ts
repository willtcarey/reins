/**
 * In-memory Clipboard API shim for Bun component tests.
 *
 * Use `installTestClipboard()` in a test, then call `restoreTestClipboard()`
 * from `afterEach` to put the original navigator back.
 */
export const originalNavigator = globalThis.navigator;

export function installTestClipboard(initialText = ""): void {
  let text = initialText;
  Reflect.set(globalThis, "navigator", {
    ...originalNavigator,
    clipboard: {
      async writeText(value: string) {
        text = value;
      },
      async readText() {
        return text;
      },
    },
  });
}

export function restoreTestClipboard(): void {
  Reflect.set(globalThis, "navigator", originalNavigator);
}
