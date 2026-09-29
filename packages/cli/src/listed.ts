/** `items` as a sentence lists them: `a`, `a and b`, `a, b and c`. Node's built-ins alone, so the launcher loads it too. */
export const listed = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
