// The preload of the `*.dom-test.ts` files (docs/dev/testing-structure.md *DOM tests*): a real DOM, set up before
// Lit loads, as Lit picks its base class when it is evaluated.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://reins.test/" });
