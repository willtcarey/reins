import { nothing, type TemplateResult } from "lit";

export function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

export function templateToString(value: unknown): string {
  if (value == null || value === false || value === nothing) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => templateToString(entry)).join("");
  }
  if (isTemplateResult(value)) {
    let output = "";
    for (let index = 0; index < value.strings.length; index += 1) {
      output += value.strings[index] ?? "";
      if (index < value.values.length) {
        output += templateToString(value.values[index]);
      }
    }
    return output;
  }
  return "";
}

export function collectTemplateValues(value: unknown): unknown[] {
  if (!isTemplateResult(value)) return [];
  return value.values.flatMap((entry) => [entry, ...collectTemplateValues(entry)]);
}

export type TemplateEventListener = (event: Event) => unknown;

function isTemplateEventListener(value: unknown): value is TemplateEventListener {
  return typeof value === "function";
}

export function collectTemplateEventListeners(
  value: unknown,
  eventName: string,
): TemplateEventListener[] {
  if (value == null || value === false || value === nothing) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTemplateEventListeners(entry, eventName));
  }
  if (!isTemplateResult(value)) return [];

  const listeners: TemplateEventListener[] = [];
  for (let index = 0; index < value.values.length; index += 1) {
    const entry = value.values[index];
    const staticBeforeEntry = value.strings[index] ?? "";
    if (
      isTemplateEventListener(entry)
      && staticBeforeEntry.trimEnd().endsWith(`@${eventName}=`)
    ) {
      listeners.push(entry);
    }
    listeners.push(...collectTemplateEventListeners(entry, eventName));
  }
  return listeners;
}
