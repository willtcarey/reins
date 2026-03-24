# Lit Conventions

Gotchas and conventions for working with Lit components in this codebase.

## Event handler `this` binding in cross-component templates

**Rule: Always use arrow wrappers for event handlers in templates rendered by a different component.**

Many components accept a callback that returns a `TemplateResult` (e.g. `popover-menu`'s `.content` property). These templates are created in one component but rendered inside another component's `render()` method.

Lit binds event handler `this` to the **rendering host component**, not the component that created the template. This means bare method references silently get the wrong `this`:

```ts
// ❌ BAD — `this` will be PopoverMenu, not MyComponent
private renderMenuContent() {
  return html`
    <button @click=${this.handleClick}>Click</button>
  `;
}

// In render():
html`<popover-menu .content=${() => this.renderMenuContent()}></popover-menu>`;
```

`this.handleClick` is called with `PopoverMenu` as `this`, so any references to `this.someProperty` will be `undefined`. TypeScript cannot catch this — it only sees a valid function reference.

```ts
// ✅ GOOD — arrow function captures the correct `this` lexically
private renderMenuContent() {
  return html`
    <button @click=${() => this.handleClick()}>Click</button>
  `;
}
```

**Why it's safe in your own `render()`:** When a template is rendered by the component that created it, Lit's host binding works correctly. So `@click=${this.handleClick}` is fine in a component's own `render()` method.

**When to watch out:** Any time a `TemplateResult` crosses a component boundary — callback props (`.content`, `.trigger`), helper methods whose output is rendered by a parent/child, etc.
