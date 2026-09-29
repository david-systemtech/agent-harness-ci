import { SHAPE_RULES, shapeRuleFinder, type ShapeRule, type ShapeRuleId } from "@agent-harness/contracts";

/**
 * Redaction in the serialiser (browser spec, "Model-boundary hygiene"):
 * whatever a page reports, what the model reads of it holds no token-shaped
 * string and no value of a field that is never read, each replaced by a
 * marker naming what was removed. The scrub registry's own pass (key-managers
 * spec) comes after, as for every tool output.
 */

/** What stands where something was removed, naming it: `[redacted: a GitHub token]`. */
const marker = (what: string): string => `[redacted: ${what}]`;

// Token-shaped strings ---------------------------------------------------------

/** A token shape: one of the scrub registry's shape rules, or one this package adds (a JSON web token). */
export type TokenShapeId = ShapeRuleId | "jwt";

/**
 * A JSON web token: a header and a payload that are each JSON written as
 * base64url (so each begins `eyJ`, `{"`), and a signature, empty for an
 * unsigned token. A bearer header's token is the scrub registry's already.
 */
const JWT: ShapeRule<"jwt"> = {
  id: "jwt",
  label: "a JSON web token",
  prefixes: ["eyJ"],
  pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
};

/**
 * The token shapes redacted from page text, as data: the scrub registry's
 * shape rules as contracts hold them (provider keys and access tokens by
 * their prefixes, AWS access key ids, PEM private keys, bearer tokens, inline
 * key assignments), then what they lack. Each prefix is in one table, and
 * both are applied by the same rule.
 */
export const TOKEN_SHAPES: readonly ShapeRule<TokenShapeId>[] = [...SHAPE_RULES, JWT];

const tokenHits = shapeRuleFinder(TOKEN_SHAPES);
const LABELS: ReadonlyMap<TokenShapeId, string> = new Map(TOKEN_SHAPES.map((shape) => [shape.id, shape.label]));

/**
 * `text` with every token-shaped string replaced by a marker naming its
 * kind. Hits that overlap are one removal, named by the first (where it
 * starts, then the table's order): a GitHub token assigned inline is a
 * GitHub token. A marker is no token, so a redacted text is left as it is.
 */
export const redactTokens = (text: string): string => {
  let redacted = "";
  let cursor = 0;
  let open: { start: number; end: number; rule: TokenShapeId } | undefined;
  const close = () => {
    if (!open) return;
    redacted += `${text.slice(cursor, open.start)}${marker(LABELS.get(open.rule) as string)}`;
    cursor = open.end;
    open = undefined;
  };
  for (const hit of tokenHits(text)) {
    if (open && hit.start < open.end) open.end = Math.max(open.end, hit.end);
    else {
      close();
      open = { ...hit };
    }
  }
  close();
  return redacted + text.slice(cursor);
};

// Fields never read --------------------------------------------------------------

/** Why a field's value is never read: a password, a payment card's details, a one-time code. */
export type SecretField = "password" | "payment-card" | "one-time-code";

const FIELD_LABELS: { readonly [K in SecretField]: string } = {
  password: "a password",
  "payment-card": "a payment card detail",
  "one-time-code": "a one-time code",
};

/**
 * A form field as the rule reads it: its type (an input's, as the attribute
 * or the property gives it, which for a select or a textarea names that) and
 * its `autocomplete` attribute. A DOM input, select or textarea is one as it
 * is, though a browser's `autocomplete` property may answer an empty string
 * for a list of tokens it does not know, so a serialiser that has the
 * element passes the attribute as written.
 */
export interface FieldAttributes {
  readonly type?: string | null;
  readonly autocomplete?: string | null;
}

/**
 * Whether a field's value is never read, and why: a password input; a field
 * whose `autocomplete` names a card detail (any `cc-` value) or a one-time
 * code; and a field whose `autocomplete` says it holds the current or a new
 * password, which is what a password field its page shows as text still
 * says. Null for every other field, whose value is read. The attribute is a
 * list of tokens (a section, billing or shipping, the field's name,
 * webauthn), each compared ignoring case.
 */
export const secretField = (field: FieldAttributes): SecretField | null => {
  if (field.type?.trim().toLowerCase() === "password") return "password";
  const tokens = (field.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (tokens.some((token) => token.startsWith("cc-"))) return "payment-card";
  if (tokens.includes("one-time-code")) return "one-time-code";
  if (tokens.includes("current-password") || tokens.includes("new-password")) return "password";
  return null;
};

/** What the serialiser writes for a field's value that is never read: a marker naming what it held. */
export const redactedFieldValue = (field: SecretField): string => marker(FIELD_LABELS[field]);
