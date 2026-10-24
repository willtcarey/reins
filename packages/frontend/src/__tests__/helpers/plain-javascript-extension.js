// An extension written without TypeScript, whose view no `ViewTypes` entry names: the SDK must work
// for it the same as for a typed one.

export function registerGreeting(reins) {
  const dispose = reins.views.register("greeting", {
    key: (view) => view.name,
    pane: {
      title: (view) => `Hello, ${view.name}`,
      description: () => "A greeting",
      icon: { mount: () => {} },
      mount: (target, view) => { target.textContent = `Hello, ${view.name}`; },
    },
  });
  reins.workspace.open({ view: "greeting", name: "Ada" });
  return dispose;
}
