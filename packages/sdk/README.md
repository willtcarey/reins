# @reins/sdk

The SDKs a Reins extension is written against:

- `@reins/sdk`: what its frontend part's register function is given (`ReinsSdk`), and the types of its views,
  sidebar sections, Settings page and HTTP calls.
- `@reins/sdk/server`: what its backend part's register function is given (`ServerSdk`) and `ServerExtension`.

Reins gives an extension these at runtime, with Lit and TypeBox: an extension does not bundle them. Depend on
this package for its types (until it is published: `"@reins/sdk": "file:<this directory>"`).

How to build an extension: `docs/features/building-extensions.md` in the Reins checkout.
