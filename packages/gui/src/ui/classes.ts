import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The class strings the primitives share, every colour in them a token
 * (ADR 0023): the surface an overlay floats on, and a row of a menu.
 */

// eslint-disable-next-line agent-harness/no-client-organisation-state -- Utility groups configure the class merger; they hold no session state.
const merge = extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: ["2xs"] }] } } });

/** Combines conditional classes, with the caller's utilities overriding the defaults. */
export const cn = (...names: ClassValue[]): string => merge(clsx(names));

/** Existing primitive callers share the same merging rules. */
export const classes = cn;

/** A menu, a popover, a tooltip or a toast: the float surface, edged with a hairline. */
export const OVERLAY = "z-50 rounded-md border border-line-strong bg-float text-sm text-ink";

/** A row of a menu, washed while highlighted and faint while disabled. */
export const MENU_ITEM =
  "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-wash data-[disabled]:text-ink-faint";
