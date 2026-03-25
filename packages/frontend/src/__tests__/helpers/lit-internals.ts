/**
 * Access Lit's internal `elementProperties` map for testing @state() vs @property().
 *
 * Uses `Reflect.get` to access the static property without type assertions,
 * since it's not part of the public HTMLElement/Function type surface.
 */
export function getElementProperties(
  el: HTMLElement,
): Map<string, { state?: boolean }> {
  return Reflect.get(el.constructor, "elementProperties");
}
