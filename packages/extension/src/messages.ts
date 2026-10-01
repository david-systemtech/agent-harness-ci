/**
 * What the options page asks of the worker through `chrome.runtime.sendMessage`,
 * which wakes the worker if Chrome stopped it, and what it answers.
 */

/** `connect`: dial now if no socket is open (the page opened). `pair`: send this code as `pair` on the announced socket. */
export type PageRequest = { readonly type: "connect" } | { readonly type: "pair"; readonly code: string; readonly name: string };

/** A pairing's outcome: paired, or the sentence the options page shows. */
export type PairOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The request `message` is, or undefined when it is none. */
export const pageRequestOf = (message: unknown): PageRequest | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const { type, code, name } = message as { readonly type?: unknown; readonly code?: unknown; readonly name?: unknown };
  if (type === "connect") return { type };
  if (type === "pair" && typeof code === "string" && typeof name === "string") return { type, code, name };
  return undefined;
};
