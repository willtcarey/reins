import type { ReactiveController, ReactiveControllerHost } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ViewMount } from "../components/view-mount.js";
import type { DecoratedHtml } from "../models/decorated-html.js";

/** What `InlineViewsController` needs of its element: the view mounts its rendered HTML put on the page. */
export interface InlineViewsHost extends ReactiveControllerHost {
  querySelectorAll(selectors: "reins-view-mount"): Iterable<ViewMount>;
}

/**
 * Renders decorated HTML for a light-DOM element and gives each of its view mounts its piece after
 * the update that rendered new HTML. The view mounts mount, update and dispose themselves, also when
 * the element leaves the page and comes back.
 */
export class InlineViewsController implements ReactiveController {
  private rendering: DecoratedHtml | null = null;
  private given: DecoratedHtml | null = null;

  constructor(private readonly host: InlineViewsHost) {
    host.addController(this);
  }

  /** The decorated HTML as a template part; call it from the host's render. */
  render(rendered: DecoratedHtml) {
    this.rendering = rendered;
    return unsafeHTML(rendered.html);
  }

  hostUpdate(): void {
    this.rendering = null;
  }

  hostUpdated(): void {
    // An update that rendered none replaced the view mounts, so the same HTML later is given again.
    const rendered = this.rendering;
    if (rendered === this.given) return;
    this.given = rendered;
    if (!rendered) return;
    for (const element of this.host.querySelectorAll("reins-view-mount")) {
      const piece = rendered.pieces[Number(element.getAttribute("data-piece"))];
      if (!piece) continue;
      element.presentation = piece.presentation;
      element.view = piece.view;
      element.context = piece.context;
    }
  }
}
