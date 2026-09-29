import type { DialogFilter } from "./electron.js";

/**
 * What the renderer sent over IPC, checked before the main process acts on
 * it: a channel hands over whatever the page chose to send, so each member
 * reads its arguments as the shell interface types them and refuses the rest.
 */

export const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be text.`);
  return value;
};

export const optionalText = (value: unknown, what: string): string | undefined => (value === undefined ? undefined : text(value, what));

export const texts = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list of text.`);
  return value.map((item) => text(item, `Each of ${what.toLowerCase()}`));
};

/** An options object; none given is an empty one. */
export const options = (value: unknown, what: string): Readonly<Record<string, unknown>> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object.`);
  return value as Record<string, unknown>;
};

export const optionalFlag = (value: unknown, what: string): boolean => {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${what} must be true or false.`);
  return value;
};

/** A count of bytes, or undefined for none. */
export const optionalCount = (value: unknown, what: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${what} must be a whole number, 0 or more.`);
  return value;
};

/** A dialog's filters, as Electron takes them. */
export const optionalFilters = (value: unknown): DialogFilter[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("A dialog's filters must be a list.");
  return value.map((filter) => {
    const { name, extensions } = options(filter, "A dialog's filter");
    return { name: text(name, "A filter's name"), extensions: texts(extensions, "A filter's extensions") };
  });
};
