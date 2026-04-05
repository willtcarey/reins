export function providerLabel(provider: string): string {
  return provider
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatDefaultModelOptionLabel(provider: string, modelName: string): string {
  return `${providerLabel(provider)} / ${modelName}`;
}

export function encodeDefaultModelSelection(provider: string, modelId: string): string {
  if (!provider || !modelId) return "";
  return JSON.stringify([provider, modelId]);
}

export function decodeDefaultModelSelection(value: string): { provider: string; modelId: string } | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === "string"
      && typeof parsed[1] === "string"
    ) {
      return { provider: parsed[0], modelId: parsed[1] };
    }
  } catch {
    return null;
  }

  return null;
}

export const THINKING_LEVELS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;
