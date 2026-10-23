import { describe, expect, test } from "bun:test";
import type { ReactiveController } from "lit";
import { ViewMount } from "../../components/view-mount.js";
import { InlineViewsController, type InlineViewsHost } from "../../controllers/inline-views-controller.js";
import { decoratedPlainText } from "../../models/decorated-html.js";
import { referenceDecorators } from "../helpers/reins-sdk.js";

const files = ["README.md", "docs/TODO.md", "src/app.ts"];
const source = { nodeId: "node", path: "/work/project" };

/** A light-DOM element whose rendered view mounts are `viewMounts`, driven through its controllers' lifecycle. */
function fakeHost(viewMounts: ViewMount[]) {
  const controllers: ReactiveController[] = [];
  const host: InlineViewsHost = {
    addController: (controller) => { controllers.push(controller); },
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
    querySelectorAll: () => viewMounts,
  };
  const inlineViews = new InlineViewsController(host);
  return {
    inlineViews,
    /** One update: `render` is what the element's render does with the controller. */
    update(render: () => void) {
      for (const controller of controllers) controller.hostUpdate?.();
      render();
      for (const controller of controllers) controller.hostUpdated?.();
    },
  };
}

function pieceMount(index: number): ViewMount {
  const element = new ViewMount();
  element.setAttribute("data-piece", String(index));
  return element;
}

describe("InlineViewsController", () => {
  test("gives each view mount its piece's view, presentation and context after the update that rendered it", () => {
    const { decorators } = referenceDecorators(files);
    const first = pieceMount(0);
    const second = pieceMount(1);
    const element = fakeHost([first, second]);
    const decorated = decoratedPlainText("docs/TODO.md and src/app.ts", decorators);

    element.update(() => element.inlineViews.render(decorated));

    expect([first, second].map(({ view, presentation, context }) => ({ view, presentation, context }))).toEqual(
      decorated.pieces.map(({ view, presentation, context }) => ({ view, presentation, context })),
    );
  });

  test("gives the same HTML's view mounts their pieces again after an update that rendered none", () => {
    const { decorators } = referenceDecorators(files);
    const viewMounts = [pieceMount(0)];
    const element = fakeHost(viewMounts);
    const decorated = decoratedPlainText("docs/TODO.md", decorators);
    element.update(() => element.inlineViews.render(decorated));

    element.update(() => {});
    viewMounts[0] = pieceMount(0);
    element.update(() => element.inlineViews.render(decorated));

    expect(viewMounts[0].view).toEqual({ view: "file-reference", source, path: "docs/TODO.md" });
  });
});
