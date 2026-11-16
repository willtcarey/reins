/** Type checks only: the implementation is what ../ui.d.ts promises extensions. */
import type * as Contract from "../ui.d.ts";
import type { ReinsBadge } from "./badge.js";
import type { ReinsSidebarRow } from "./sidebar-row.js";
import type * as Implementation from "./index.js";

type Is<T, _Contract extends T> = true;

export type Checks = [
  Is<Contract.ReinsBadgeElement, ReinsBadge>,
  Is<Contract.ReinsSidebarRowElement, ReinsSidebarRow>,
  Is<typeof Contract.define, typeof Implementation.define>,
];
