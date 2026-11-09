import { afterEach, describe, expect, test } from "bun:test";
import type { HttpOutput } from "@reins/sdk";
import type { SecretsApi } from "@backend/extensions/secrets/api.js";
import { registerSecrets } from "../../../extensions/secrets/index.js";
import { SecretsRequestForm } from "../../../extensions/secrets/request-form.js";
import { testSdk } from "../../helpers/reins-sdk.js";
import { clickButton, collectTemplateEventListeners, templateToString, typeIntoField } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

/** A field as the form's input listener reads it: the test makes it the page's `HTMLInputElement`. */
class TestInputElement extends EventTarget {
  value = "";
}
Reflect.set(globalThis, "HTMLInputElement", TestInputElement);

type OpenRequest = HttpOutput<SecretsApi["requests"]>[number];

const request = (id: string, sessionId: string): OpenRequest => ({
  id, sessionId, purpose: "Configure the server", createdAt: "2026-04-01T10:00:00.000Z",
  fields: [{ name: "OPENAI_API_KEY", description: "OpenAI key" }, { name: "RESEND_API_KEY", description: null }],
});
const sessionShown = (sessionId: string) => ({ view: { view: "session", sessionId }, subject: [{ type: "session" as const, id: sessionId }] });

describe("the secrets extension's frontend part", () => {
  afterEach(() => { restoreFetch(); });

  test("opens a request's form in the Inspector once, when the user goes to the session that asked", async () => {
    let open = [request("r1", "s1")];
    mockFetch(() => Response.json(open));
    const sdk = testSdk<SecretsApi>({ extension: { name: "secrets", label: "Secrets" } });
    registerSecrets(sdk.reins);
    await Bun.sleep(0);

    sdk.showMain(sessionShown("s2"));
    await Bun.sleep(0);
    const elsewhere = [...sdk.opened];
    sdk.showMain(sessionShown("s1"));
    sdk.showMain(sessionShown("s2"));
    sdk.showMain(sessionShown("s1"));
    await Bun.sleep(0);
    open = [request("r1", "s1"), request("r2", "s1")];
    sdk.client.fireMessage({ type: "extension", extension: "secrets", message: { type: "changed" } });
    await Bun.sleep(0);

    expect(elsewhere).toEqual([]);
    expect(sdk.opened).toEqual([
      { view: { view: "secrets-request", requestId: "r1" }, container: "inspector" },
      { view: { view: "secrets-request", requestId: "r2" }, container: "inspector" },
    ]);
  });

  test("closes a request's tab once the request ends, here or in another browser", async () => {
    let open = [request("r1", "s1"), request("r2", "s1")];
    mockFetch(() => Response.json(open));
    const sdk = testSdk<SecretsApi>({ extension: { name: "secrets", label: "Secrets" } });
    registerSecrets(sdk.reins);
    await Bun.sleep(0);

    open = [request("r2", "s1")];
    sdk.client.fireMessage({ type: "extension", extension: "secrets", message: { type: "changed" } });
    await Bun.sleep(0);

    expect(sdk.closed).toEqual([{ view: "secrets-request", requestId: "r1" }]);
  });

  describe("the form", () => {
    const form = (submitted: Record<string, string>[] = [], cancelled: string[] = []) => {
      const element = new SecretsRequestForm();
      element.request = request("r1", "s1");
      element.submit = async values => { submitted.push(values); };
      element.cancel = async () => { cancelled.push("r1"); };
      return element;
    };
    const send = (element: SecretsRequestForm) => collectTemplateEventListeners(element.render(), "submit")[0]!.call(element, Object.assign(new Event("submit"), { preventDefault() {} }));

    test("shows the purpose, the names and their descriptions, each value masked until the user shows it", () => {
      const element = form();

      const masked = templateToString(element.render());
      clickButton(element.render(), "Show OPENAI_API_KEY");
      const shown = templateToString(element.render());

      expect(masked).toContain("Configure the server");
      expect(masked).toContain("OpenAI key");
      expect(masked.match(/type="?password/g)).toHaveLength(2);
      expect(shown.match(/type="?password/g)).toHaveLength(1);
      expect(shown).toContain("Hide OPENAI_API_KEY");
    });

    test("does not send a blank value or one of more than one line", async () => {
      const submitted: Record<string, string>[] = [];
      const element = form(submitted);
      typeIntoField(element.render(), "OPENAI_API_KEY", "one\ntwo", new TestInputElement());
      typeIntoField(element.render(), "RESEND_API_KEY", "re_1", new TestInputElement());

      await send(element);

      expect(submitted).toEqual([]);
      expect(templateToString(element.render())).toContain("Each value must be one non-empty line of at most 16 KiB");
    });

    test("sends the values, then says they are stored and forgets them", async () => {
      const submitted: Record<string, string>[] = [];
      const element = form(submitted);
      typeIntoField(element.render(), "OPENAI_API_KEY", "sk-1", new TestInputElement());
      typeIntoField(element.render(), "RESEND_API_KEY", "re_1", new TestInputElement());

      await send(element);
      const after = templateToString(element.render());

      expect(submitted).toEqual([{ OPENAI_API_KEY: "sk-1", RESEND_API_KEY: "re_1" }]);
      expect(after).toContain("Stored");
      expect(after).not.toContain("sk-1");
    });

    test("cancel ends the request; a request that ended elsewhere says so", async () => {
      const cancelled: string[] = [];
      const element = form([], cancelled);

      clickButton(element.render(), "Cancel");
      await Bun.sleep(0);
      const ended = form();
      ended.request = null;

      expect(cancelled).toEqual(["r1"]);
      expect(templateToString(ended.render())).toContain("This request has ended");
    });
  });
});
