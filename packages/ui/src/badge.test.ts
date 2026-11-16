import { afterEach, describe, expect, test } from "bun:test";
import "@reins/ui";

const ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>`;

afterEach(() => document.body.replaceChildren());

/** A badge as plain DOM makes it: attributes only. */
async function badge(attributes: Record<string, string>) {
  const element = document.createElement("reins-badge");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  await customElements.whenDefined("reins-badge");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return element;
}

/** What it draws, without Lit's markers. */
const drawn = (element: HTMLElement) => [...element.childNodes].filter((node) => node.nodeType !== Node.COMMENT_NODE);

describe("<reins-badge>", () => {
  test("draws its value in the light DOM, in its tone, neutral by default", async () => {
    const attention = await badge({ value: "3", tone: "attention", title: "Need you" });
    const neutral = await badge({ value: "new" });

    expect(attention.shadowRoot).toBeNull();
    expect(attention.textContent).toBe("3");
    expect(attention.getAttribute("tone")).toBe("attention");
    expect(attention.title).toBe("Need you");
    expect(neutral.textContent).toBe("new");
    expect(neutral.getAttribute("tone")).toBe("neutral");
  });

  test("draws its icon before the value", async () => {
    const [icon, value] = drawn(await badge({ value: "2", icon: ICON }));

    expect(icon instanceof HTMLElement && icon.classList.contains("reins-badge-icon") && icon.querySelector("svg circle") !== null).toBe(true);
    expect(value?.textContent).toBe("2");
  });

  test("draws nothing for a count of 0 or no value, and its value once a property gives it one", async () => {
    const zero = await badge({ value: "0", tone: "info" });
    const none = await badge({ tone: "info" });
    expect([zero.textContent, none.textContent]).toEqual(["", ""]);

    // As Svelte sets it: a property, a number.
    zero.value = 4;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(zero.getAttribute("value")).toBe("4");
    expect(zero.textContent).toBe("4");
  });
});
