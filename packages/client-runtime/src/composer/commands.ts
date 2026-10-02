import type { CommandsListEntry } from "@agent-harness/contracts";

/**
 * The slash menu's rows and order (docs/specs/tui.md, "The composer";
 * docs/specs/gui.md, "A session pane"; #503): one rule for every renderer,
 * so the menu lists the same skills in the terminal as in the window, and
 * the command a word reaches first in one is the one it reaches in the other.
 */

/** Whose a row of the slash menu is: the client's own command, a skill of the session's set, or the provider's own command. */
export type SlashMenuSource = "client" | "skill" | "provider";

/** A row of the slash menu. */
export interface SlashMenuRow {
  /** What choosing it types after the slash: the command's or skill's name, or `skill:<name>` for a skill whose `/name` another takes. */
  readonly name: string;
  /** How it is typed, with what follows the name (a skill's argument hint). */
  readonly usage: string;
  readonly description: string;
  /** Whose it is: a skill's and the provider's go to the agent as typed, a client's the client answers itself. */
  readonly source: SlashMenuSource;
  /** A slash-only skill, which a person invokes and the model is never told of: marked in the menu. */
  readonly slashOnly: boolean;
}

/** A command the client answers itself, as its menu lists it. */
export interface ClientCommandRow {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

/**
 * The slash menu's rows for a session: the client's own commands, then the
 * skills of the session's `commands.list`, slash-only ones marked, then the
 * provider's own commands. `answers` says whether the client answers
 * `/<name>` itself, as its own verbs win inside it (skills spec, "Slash
 * resolution"). A skill whose `/<name>` the client or a provider built-in
 * takes is reached as `/skill:<name>`; a provider command the client's
 * `/<name>` takes is left out, and so is one that is not a built-in when a
 * skill's or a built-in's `/<name>` reaches that instead, so no two rows
 * type the same.
 */
export const slashMenuRows = (own: readonly ClientCommandRow[], listing: readonly CommandsListEntry[], answers: (name: string) => boolean): SlashMenuRow[] => {
  const builtins = new Set(listing.flatMap((entry) => (entry.kind === "command" && entry.builtin ? [entry.name] : [])));
  const skillNames = new Set(listing.flatMap((entry) => (entry.kind === "skill" ? [entry.name] : [])));
  const rows: SlashMenuRow[] = own.map(({ name, usage, description }) => ({ name, usage, description, source: "client", slashOnly: false }));
  for (const entry of listing) {
    if (entry.kind !== "skill") continue;
    const name = answers(entry.name) || builtins.has(entry.name) ? `skill:${entry.name}` : entry.name;
    const usage = entry.argumentHint === null ? `/${name}` : `/${name} ${entry.argumentHint}`;
    rows.push({ name, usage, description: entry.description, source: "skill", slashOnly: entry.invocation === "slash-only" });
  }
  for (const entry of listing) {
    if (entry.kind !== "command" || answers(entry.name) || (!entry.builtin && (skillNames.has(entry.name) || builtins.has(entry.name)))) continue;
    rows.push({ name: entry.name, usage: `/${entry.name}`, description: entry.description, source: "provider", slashOnly: false });
  }
  return rows;
};

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
