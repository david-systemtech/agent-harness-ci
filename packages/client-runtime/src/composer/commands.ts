/**
 * The slash menu's order (docs/specs/tui.md, "The composer"; docs/specs/gui.md,
 * "A session pane"): one rule for every renderer, so the command a word
 * reaches first in the terminal is the one it reaches in the window.
 */

/** Whether `name` holds `query`'s letters in order. */
const subsequence = (query: string, name: string): boolean => {
  let at = 0;
  for (const char of name) if (char === query[at]) at++;
  return at === query.length;
};

/**
 * Commands matching the word typed after `/`, ignoring its case: the one it
 * names exactly first, then those it begins, then those holding its letters
 * in order, each group in the order given.
 */
export const matchCommands = <Row extends { readonly name: string }>(word: string, commands: readonly Row[]): Row[] => {
  const query = word.toLowerCase();
  const exact = commands.filter((c) => c.name === query);
  const starts = commands.filter((c) => c.name !== query && c.name.startsWith(query));
  const rest = commands.filter((c) => !c.name.startsWith(query) && subsequence(query, c.name));
  return [...exact, ...starts, ...rest];
};
