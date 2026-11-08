# @reins/sdk

The SDKs a Reins extension is written against:

- `@reins/sdk`: what its frontend part's register function is given (`ReinsSdk`), the types of its views,
  sidebar sections, Settings page and HTTP calls, and `SCOPE_ATTRIBUTE`.
- `@reins/sdk/server`: what its backend part's register function is given (`ServerSdk`) and `ServerExtension`.
- `@reins/sdk/lit`: custom elements for a Lit frontend part, each bundle in a registry of its own
  (`defineElement`, `ScopedElement`, `mountElement`).

Reins gives the SDK objects at run time. The few values here (`SCOPE_ATTRIBUTE`, `@reins/sdk/lit`) are bundled
into the extension like its other code; only `lit` stays out of a frontend bundle, as the page provides it.
TypeBox is not provided: a backend part bundles its own. Until this package is published, depend on it as
`"@reins/sdk": "file:<this directory>"`.

How to build an extension: `docs/features/building-extensions.md` in the Reins checkout.
