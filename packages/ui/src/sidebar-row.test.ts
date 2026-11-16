import { afterEach, describe, expect, test } from "bun:test";
import "@reins/ui";

const ICON = `<svg viewBox="0 0 24 24"><path d="M2 12h20"></path></svg>`;

afterEach(() => document.body.replaceChildren());

/** A row as plain DOM makes it: attributes, and badges as its children (`later`: added once it is on the page). */
async function row(attributes: Record<string, string>, badges: string[] = [], later: string[] = []) {
  const element = document.createElement("reins-sidebar-row");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  const add = (value: string) => {
    const child = document.createElement("reins-badge");
    child.setAttribute("value", value);
    element.append(child);
  };
  badges.forEach(add);
  document.body.append(element);
  await customElements.whenDefined("reins-sidebar-row");
  await new Promise((resolve) => setTimeout(resolve, 0));
  later.forEach(add);
  return element;
}

const button = (element: HTMLElement) => element.querySelector("button")!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("<reins-sidebar-row>", () => {
  test("draws, in the light DOM, a button with its icon and label, then its badges", async () => {
    const element = await row({ label: "Inbox", icon: ICON }, ["2"], ["1"]);

    expect(element.shadowRoot).toBeNull();
    expect(button(element).type).toBe("button");
    expect(button(element).querySelector(".reins-sidebar-row-icon svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(button(element).querySelector(".reins-sidebar-row-label")?.textContent).toBe("Inbox");
    const order = [...element.children].map((child) => child.localName === "reins-badge" ? child.getAttribute("value") : child.localName);
    expect(order).toEqual(["button", "2", "1"]);
    expect(button(element).hasAttribute("aria-current")).toBe(false);
  });

  test("marks the current row for its look and for assistive technology", async () => {
    const element = await row({ label: "Inbox", current: "" });

    expect(button(element).getAttribute("aria-current")).toBe("page");
    expect(button(element).querySelector(".reins-sidebar-row-icon")).toBeNull();

    element.current = false;
    await settle();
    expect(element.hasAttribute("current")).toBe(false);
    expect(button(element).hasAttribute("aria-current")).toBe(false);
  });

  test("reads its accessible label, with the counts, instead of the label", async () => {
    const counted = await row({ label: "Inbox", "accessible-label": "Inbox: 2 need you" });
    const plain = await row({ label: "Inbox" });

    expect(button(counted).getAttribute("aria-label")).toBe("Inbox: 2 need you");
    expect(button(plain).getAttribute("aria-label")).toBe("Inbox");
  });

  test("a press, on its button or its badges, is a click on the row", async () => {
    const element = await row({ label: "Inbox" }, ["3"]);
    let clicks = 0;
    element.addEventListener("click", () => { clicks += 1; });

    button(element).click();
    element.querySelector("reins-badge")!.click();

    expect(clicks).toBe(2);
  });
});
