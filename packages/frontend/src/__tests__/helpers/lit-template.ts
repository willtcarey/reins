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

/** The `@click` listeners of the rendered `<button>`s, with each button's visible text. */
function collectButtons(value: unknown): Array<{ label: string; click: TemplateEventListener }> {
  if (Array.isArray(value)) return value.flatMap((entry) => collectButtons(entry));
  if (!isTemplateResult(value)) return [];

  const buttons: Array<{ label: string; click: TemplateEventListener }> = [];
  for (let index = 0; index < value.values.length; index += 1) {
    const entry = value.values[index];
    if (isTemplateEventListener(entry) && (value.strings[index] ?? "").trimEnd().endsWith("@click=")) {
      // The rest of the opening tag and the button's content, up to its end tag.
      let rest = "";
      for (let next = index + 1; next < value.strings.length && !rest.includes("</button>"); next += 1) {
        rest += (value.strings[next] ?? "") + (next < value.values.length && !rest.includes("</button>") ? templateToString(value.values[next]) : "");
      }
      const end = rest.indexOf("</button>");
      if (end >= 0 && !rest.slice(0, end).includes("<button")) {
        const content = rest.slice(rest.indexOf(">") + 1, end);
        buttons.push({ label: content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), click: entry });
      }
    }
    buttons.push(...collectButtons(entry));
  }
  return buttons;
}

/** Clicks the one rendered button whose visible text is `label`; throws unless exactly one matches. */
export function clickButton(value: unknown, label: string): void {
  const matches = collectButtons(value).filter((button) => button.label === label);
  if (matches.length !== 1) throw new Error(`Expected one "${label}" button, found ${matches.length}`);
  void matches[0]!.click(new Event("click"));
}
