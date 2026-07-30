interface ClipboardOperations {
  writeText?: (text: string) => Promise<void>;
  fallbackCopy: (text: string) => boolean;
}

/**
 * Copy text in both secure browser contexts and local HTTP deployments.
 * The async Clipboard API is preferred, with execCommand as a compatibility
 * fallback for browsers that do not expose it outside a secure context.
 */
export async function copyTextToClipboard(
  text: string,
  operations: ClipboardOperations = browserClipboardOperations(),
): Promise<void> {
  try {
    if (operations.writeText) {
      await operations.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy copy path.
  }

  if (!operations.fallbackCopy(text)) {
    throw new Error("Could not copy text");
  }
}

function browserClipboardOperations(): ClipboardOperations {
  return {
    writeText: navigator.clipboard
      ? (text) => navigator.clipboard.writeText(text)
      : undefined,
    fallbackCopy: copyTextFallback,
  };
}

function copyTextFallback(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
