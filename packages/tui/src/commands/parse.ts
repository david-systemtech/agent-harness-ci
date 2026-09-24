import type { PairingInput } from "@agent-harness/client-runtime";

/**
 * The slash commands this build answers (docs/specs/tui.md, "First launch"):
 * `/pair <link>`, `/pair <address> <code>`, `/pair create`, `/environment`.
 * Text that is not one goes to a session, which the transcript ticket
 * opens; until then it is answered with one line.
 */
export type Command =
  | { readonly kind: "pair"; readonly input: PairingInput }
  | { readonly kind: "pair-create" }
  | { readonly kind: "environment" }
  | { readonly kind: "usage"; readonly line: string }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "text"; readonly text: string };

export const PAIR_USAGE = "Usage: /pair <link>, /pair <address> <code>, or /pair create.";

export const parseCommand = (typed: string): Command => {
  const text = typed.trim();
  if (!text.startsWith("/")) return { kind: "text", text };
  const [name = "", ...rest] = text.slice(1).split(/\s+/);
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
    default:
      return { kind: "unknown", name };
  }
};
