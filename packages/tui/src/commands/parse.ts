import type { PairingInput } from "@agent-harness/client-runtime";
import { actionById, isCommandId } from "@agent-harness/contracts";
import { PICKER_COMMANDS, TAKES_ENVIRONMENT, isPickerCommand, type PickerCommand } from "../pickers/commands.js";
import { RAIL_COMMANDS, isRailCommand, type RailCommand } from "../rail/commands.js";

/**
 * The slash commands this build answers (docs/specs/tui.md, "First launch",
 * "The composer" and "Shortcuts"): `/pair <link>`, `/pair <address> <code>`,
 * `/pair create`, `/environment`, `/help`, `/reload`; and, carried from
 * Artemis with the transcript and the composer, `/resume`, `/new`,
 * `/attach <path>`, `/snip`, `/tasks`, `/copy`, `/export [file]`,
 * `/timeline` and `/quit`; the accounts, models, permissions, settings and
 * Set up commands (`pickers/commands.ts`, #147); with the cards, `/asks`
 * and `/notices`; with the rail, `/archive`, `/pin`, `/title`, `/group`,
 * `/tag`, `/settle`, `/snooze`, `/restore`, `/search` and `/cwd`
 * (`rail/commands.ts`); with fork and rewind (ADR 0022; #232), `/rewind [n]`
 * (n prompts back, one by default), `/rewind undo` and `/fork [n]` (bare,
 * the whole session). A command of the shared list this build does not
 * answer yet says so in one line, and one the list keeps absent gives its
 * reason; `/profile` is a hidden alias of `/account`. Anything else that
 * begins with a slash is not the terminal's: it goes to the agent as typed,
 * which is how the provider's own commands are run (Artemis's rule). What
 * follows a `/` is syntax, whatever key opens the command menu.
 */

/** The slash commands `parseCommand` knows, by their names in the shared action list (`command.<name>`); the rail's are its own (`rail/commands.ts`). */
export const ANSWERED_COMMANDS = [
  "pair",
  "environment",
  "help",
  "reload",
  "resume",
  "new",
  "attach",
  "snip",
  "tasks",
  "copy",
  "export",
  "timeline",
  "quit",
  ...PICKER_COMMANDS,
  "asks",
  "notices",
  ...RAIL_COMMANDS,
  "fork",
  "rewind",
] as const;

export type Command =
  | { readonly kind: "pair"; readonly input: PairingInput }
  | { readonly kind: "pair-create" }
  | { readonly kind: "environment" }
  | { readonly kind: "help" }
  | { readonly kind: "reload" }
  | { readonly kind: "rail"; readonly command: RailCommand }
  | { readonly kind: "resume" }
  | { readonly kind: "new" }
  | { readonly kind: "attach"; readonly path: string }
  | { readonly kind: "snip-list" }
  | { readonly kind: "snip"; readonly name: string; readonly words: readonly string[] }
  | { readonly kind: "snip-save"; readonly name: string; readonly body: string }
  | { readonly kind: "snip-remove"; readonly name: string }
  | { readonly kind: "snip-examples" }
  | { readonly kind: "tasks" }
  | { readonly kind: "copy"; readonly block: number | null }
  | { readonly kind: "export"; readonly file: string | null }
  | { readonly kind: "timeline" }
  | { readonly kind: "quit" }
  | { readonly kind: "picker"; readonly command: PickerCommand }
  | { readonly kind: "asks" }
  | { readonly kind: "notices" }
  /** `/rewind [n]`: to the prompt `back` prompts from the end (1, the latest). */
  | { readonly kind: "rewind"; readonly back: number }
  | { readonly kind: "rewind-undo" }
  /** `/fork [n]`: before the prompt `back` prompts from the end, or (null) the whole session. */
  | { readonly kind: "fork"; readonly back: number | null }
  /** A command of the shared list this build does not answer: `line` says why. */
  | { readonly kind: "not-here"; readonly name: string; readonly line: string }
  | { readonly kind: "usage"; readonly line: string }
  /** Text for the agent: a message, or a slash command the terminal does not know, as typed. */
  | { readonly kind: "text"; readonly text: string };

export const PAIR_USAGE = "Usage: /pair <link>, /pair <address> <code>, or /pair create.";
export const REWIND_USAGE = "Usage: /rewind [n | undo]: n prompts back, one by default; undo takes the rewind back.";
export const FORK_USAGE = "Usage: /fork [n]: bare, the whole session; n, before the prompt n back.";

/** A count of prompts back: a whole number from one; undefined for anything else. */
const countBack = (word: string): number | undefined => (/^[1-9][0-9]*$/.test(word) ? Number(word) : undefined);

/** The hidden aliases: the name typed, and the command it names. */
const ALIASES: Readonly<Record<string, string>> = { profile: "account", environments: "environment" };

/** What a command of the list this build does not answer says: its reason when the list keeps it absent. */
const notHere = (name: string): Command => {
  const action = actionById(`command.${name}`);
  const line = action?.status === "absent" ? `/${name} is not here: ${action.reason}` : `/${name} is not in this build of the terminal UI yet.`;
  return { kind: "not-here", name, line };
};

const bare = (rest: readonly string[], command: Command, usage: string): Command => (rest.length === 0 ? command : { kind: "usage", line: `Usage: ${usage}` });

export const parseCommand = (typed: string): Command => {
  const text = typed.trim();
  if (!text.startsWith("/")) return { kind: "text", text };
  const [word = "", ...rest] = text.slice(1).split(/\s+/);
  const lowered = word.toLowerCase();
  const name = ALIASES[lowered] ?? lowered;
  // Everything after the command word, as typed: a snippet's body keeps its lines.
  const tail = text.slice(1 + word.length).trim();
  if (isPickerCommand(name)) {
    const command: Command = { kind: "picker", command: { name, argument: tail } };
    return TAKES_ENVIRONMENT.has(name) ? command : bare(rest, command, `/${name}`);
  }
  // The rail's forms take what follows the name whole, spaces kept: a title or a group's name has several words. None of
  // them is a name the switch below answers.
  if (isRailCommand(name)) return { kind: "rail", command: { name, text: tail } };
  switch (name) {
    case "pair": {
      if (rest.length === 1 && rest[0] === "create") return { kind: "pair-create" };
      const [first = "", second, third] = rest;
      if (rest.length === 1) return { kind: "pair", input: { link: first } };
      // A link carries its code: anything after it is a mistake, not a code.
      if (first.includes("#")) return { kind: "usage", line: PAIR_USAGE };
      if (rest.length === 2) return { kind: "pair", input: { address: first, code: second as string } };
      // A code typed in its two groups of five, `K7Q2M XH4RT`, is one code; three words of any other shape are a mistake.
      if (rest.length === 3 && second?.length === 5 && third?.length === 5) return { kind: "pair", input: { address: first, code: `${second}${third}` } };
      return { kind: "usage", line: PAIR_USAGE };
    }
    case "environment":
      return bare(rest, { kind: "environment" }, "/environment");
    case "help":
      return bare(rest, { kind: "help" }, "/help");
    case "reload":
      return bare(rest, { kind: "reload" }, "/reload");
    case "resume":
      return bare(rest, { kind: "resume" }, "/resume");
    case "new":
      return bare(rest, { kind: "new" }, "/new");
    case "tasks":
      return bare(rest, { kind: "tasks" }, "/tasks");
    case "timeline":
      return bare(rest, { kind: "timeline" }, "/timeline");
    case "quit":
      return bare(rest, { kind: "quit" }, "/quit");
    case "asks":
      return bare(rest, { kind: "asks" }, "/asks");
    case "notices":
      return bare(rest, { kind: "notices" }, "/notices");
    case "rewind": {
      if (rest.length === 0) return { kind: "rewind", back: 1 };
      const [first = ""] = rest;
      if (rest.length === 1 && first.toLowerCase() === "undo") return { kind: "rewind-undo" };
      const back = rest.length === 1 ? countBack(first) : undefined;
      return back === undefined ? { kind: "usage", line: REWIND_USAGE } : { kind: "rewind", back };
    }
    case "fork": {
      if (rest.length === 0) return { kind: "fork", back: null };
      const [first = ""] = rest;
      const back = rest.length === 1 ? countBack(first) : undefined;
      return back === undefined ? { kind: "usage", line: FORK_USAGE } : { kind: "fork", back };
    }
    case "attach":
      return tail.length > 0 ? { kind: "attach", path: tail } : { kind: "usage", line: "Usage: /attach <path>" };
    case "export":
      return { kind: "export", file: tail.length > 0 ? tail : null };
    case "copy": {
      if (rest.length === 0) return { kind: "copy", block: null };
      const block = Number(rest[0]);
      return rest.length === 1 && Number.isInteger(block) && block >= 1 ? { kind: "copy", block } : { kind: "usage", line: "Usage: /copy, or /copy <n> for the nth code block of the last reply" };
    }
    case "snip": {
      const [first, second] = rest;
      if (first === undefined) return { kind: "snip-list" };
      if (first === "--examples") return bare(rest.slice(1), { kind: "snip-examples" }, "/snip --examples");
      if (first === "save") {
        // The body is the rest of the line as typed, its line breaks kept: a template's lines are part of it.
        const afterSave = tail.slice("save".length).replace(/^\s+/, "");
        const body = second === undefined ? "" : afterSave.slice(second.length).replace(/^[ \t]*\n?/, "");
        if (second === undefined || body.trim().length === 0) return { kind: "usage", line: "Usage: /snip save <name> <the template>, with the text to save after the name." };
        return { kind: "snip-save", name: second, body };
      }
      if (first === "rm") return second !== undefined && rest.length === 2 ? { kind: "snip-remove", name: second } : { kind: "usage", line: "Usage: /snip rm <name>" };
      return { kind: "snip", name: first, words: rest.slice(1) };
    }
    default:
      // A command of the shared list this build does not answer is still the terminal's, never the agent's.
      if (isCommandId(`command.${name}`)) return notHere(name);
      return { kind: "text", text };
  }
};
