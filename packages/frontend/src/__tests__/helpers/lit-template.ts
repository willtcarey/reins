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
