import type { PairingInput } from "@agent-harness/client-runtime";
import { RAIL_COMMANDS, isRailCommand, type RailCommand } from "../rail/commands.js";

/**
 * The slash commands this build answers (docs/specs/tui.md, "First launch"
 * and "Shortcuts"): `/pair <link>`, `/pair <address> <code>`, `/pair create`,
 * `/environment`, `/help`, `/reload`. Text that is not one goes to a session,
 * which the transcript ticket opens; until then it is answered with one line.
 * What follows a `/` is syntax, whatever key opens the command menu.
 */

/** The slash commands `parseCommand` knows, by their names in the shared action list (`command.<name>`); the rail's are its own (`rail/commands.ts`). */
export const ANSWERED_COMMANDS = ["pair", "environment", "help", "reload", ...RAIL_COMMANDS] as const;
export type Command =
  | { readonly kind: "pair"; readonly input: PairingInput }
  | { readonly kind: "pair-create" }
  | { readonly kind: "environment" }
  | { readonly kind: "help" }
  | { readonly kind: "reload" }
  | { readonly kind: "rail"; readonly command: RailCommand }
  | { readonly kind: "usage"; readonly line: string }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "text"; readonly text: string };

export const PAIR_USAGE = "Usage: /pair <link>, /pair <address> <code>, or /pair create.";

export const parseCommand = (typed: string): Command => {
  const text = typed.trim();
  if (!text.startsWith("/")) return { kind: "text", text };
  const [name = "", ...rest] = text.slice(1).split(/\s+/);
  // The rail's forms take what follows the name whole, spaces kept: a title or a group's name has several words.
  if (isRailCommand(name)) return { kind: "rail", command: { name, text: text.slice(1 + name.length).trim() } };
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
    case "environments":
      return rest.length === 0 ? { kind: "environment" } : { kind: "usage", line: "Usage: /environment" };
    case "help":
      return rest.length === 0 ? { kind: "help" } : { kind: "usage", line: "Usage: /help" };
    case "reload":
      return rest.length === 0 ? { kind: "reload" } : { kind: "usage", line: "Usage: /reload" };
    default:
      return { kind: "unknown", name };
  }
};
