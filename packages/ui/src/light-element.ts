import { LitElement } from "lit";

/** A kit element's base: it draws in the light DOM, before the children it was given (a row's badges), so a
 * framework's children and the kit's own parts share the element without either moving the other's. It draws
 * before a marker of its own: Lit keeps its render state on the `renderBefore` node, and a child that is a Lit
 * element keeps its own there. */
export class LightElement extends LitElement {
  override createRenderRoot() {
    const marker = document.createComment("");
    this.insertBefore(marker, this.firstChild);
    this.renderOptions.renderBefore = marker;
    return this;
  }
}
