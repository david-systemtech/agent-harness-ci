/**
 * The class strings the primitives share, every colour in them a token
 * (ADR 0023): the surface an overlay floats on, and a row of a menu.
 */

/** Joins class strings, leaving out the ones not given. */
export const classes = (...names: readonly (string | false | undefined)[]): string => names.filter((name) => typeof name === "string" && name !== "").join(" ");

/** A menu, a popover, a tooltip or a toast: the float surface, edged with a hairline. */
export const OVERLAY = "z-50 rounded-md border border-line-strong bg-float text-sm text-ink";

/** A row of a menu, washed while highlighted and faint while disabled. */
export const MENU_ITEM =
  "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-wash data-[disabled]:text-ink-faint";
