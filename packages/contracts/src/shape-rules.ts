import { z } from "zod";
import { errorSchema } from "./errors.js";

/**
 * The scrub registry's shape rules (key-managers spec, "The scrub
 * registry"; ADR 0011): what a secret looks like when the harness never
 * registered it. Each rule is anchored on a recognisable prefix, with a word
 * boundary before it (no letter or digit, so `_` and `-` separate words as
 * they do in `GITHUB_TOKEN` and `X-Api-Key`), and asks only for the body the
 * prefix is known to carry; none guesses from how random a string looks.
 *
 * Shape rules are applied to what the harness itself writes and keeps (its
 * log lines, captured output, error text) and checked on what it sends out
 * for the user (an issue's or a pull request's body, a memory draft); never
 * to content at the event log's append, since a secret the model or the user
 * handles on their own is outside the registry.
 */

/** The shape rules' ids, in the order they are checked. */
export const SHAPE_RULE_IDS = [
  "anthropic",
  "openai-style",
  "aws",
  "google",
  "github",
  "private-key",
  "bearer",
  "key-assignment",
  "openbao",
  "doppler",
  "onepassword",
  "bitwarden",
] as const;
export const ShapeRuleId = z.enum(SHAPE_RULE_IDS).meta({
  description:
    "A shape rule of the scrub registry: anthropic, openai-style (an sk- key), aws (an access key id), google, github, private-key (a PEM private key), bearer, key-assignment (a value after a key's name and = or :), openbao (OpenBao and Vault tokens), doppler, onepassword (a service-account token) or bitwarden (an access token).",
});
export type ShapeRuleId = z.infer<typeof ShapeRuleId>;

/** One shape rule. */
export interface ShapeRule {
  readonly id: ShapeRuleId;
  /** What it finds, as a sentence names it: `a GitHub token`. */
  readonly label: string;
  /** The prefixes it is anchored on: each hit begins with one, or, for a rule hiding the value after a name, with the name. Compared ignoring case where the pattern does. */
  readonly prefixes: readonly string[];
  /**
   * What it matches, from its prefix on; the boundary before the prefix is
   * added where the rule is applied. A group named `secret` is the part
   * hidden; without one, the whole match is. Its only flag is `i`, where
   * the prefix is matched ignoring case.
   */
  readonly pattern: RegExp;
}

/** The key names a value assigned inline is recognised by, the last word of the name before `=` or `:`. */
const ASSIGNED_KEYS = "api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|passw(?:or)?d";

/** What an assigned value is made of: no space, quote, `.`, `$` or bracket, so an expression or a variable is no value. */
const ASSIGNED_VALUE = "[A-Za-z0-9_+/=~-]";

export const SHAPE_RULES: readonly ShapeRule[] = [
  {
    id: "anthropic",
    label: "an Anthropic API key",
    prefixes: ["sk-ant-"],
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "openai-style",
    label: "an OpenAI-style API key",
    prefixes: ["sk-"],
    // A kind among sk-proj-, sk-svcacct-, sk-admin-, sk-None- and OpenRouter's sk-or-v1-, or a legacy key's unbroken run.
    // Never after a hyphen: a kebab-case name's -sk- segment (deploy-sk-<hash>) is none.
    pattern: /(?<!-)sk-(?!ant-)(?:(?:proj|svcacct|admin|None|or-v1)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,}[A-Za-z0-9_-]*)/,
  },
  {
    id: "aws",
    label: "an AWS access key",
    prefixes: ["AKIA", "ASIA", "ABIA", "ACCA", "AGPA", "AIDA", "AIPA", "ANPA", "ANVA", "APKA", "AROA"],
    pattern: /(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  },
  {
    id: "google",
    label: "a Google API key or OAuth credential",
    prefixes: ["AIza", "GOCSPX-", "ya29."],
    pattern: /AIza[A-Za-z0-9_-]{35,}|GOCSPX-[A-Za-z0-9_-]{24,}|ya29\.[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "github",
    label: "a GitHub token",
    prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/,
  },
  {
    id: "private-key",
    label: "a PEM private key",
    prefixes: ["-----BEGIN"],
    // From the header to its footer, or to the end of the text when it was cut before one.
    pattern: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/,
  },
  {
    id: "bearer",
    label: "a bearer token",
    prefixes: ["Bearer"],
    pattern: /Bearer[ \t]+(?<secret>[A-Za-z0-9._~+/-]{16,}=*)/i,
  },
  {
    id: "key-assignment",
    label: "a key assigned inline",
    prefixes: ["api_key", "api-key", "apikey", "access_key", "access-key", "accesskey", "secret_key", "secret-key", "secretkey", "private_key", "private-key", "privatekey", "secret", "token", "password", "passwd"],
    // After `=` any value; after `:` a quoted one or one holding a digit, so a type annotation (`token: ForgeCredential`) is none.
    pattern: new RegExp(
      `(?:${ASSIGNED_KEYS})["']?(?:\\s*=\\s*["']?|\\s*:\\s*(?:["']|(?=${ASSIGNED_VALUE}*\\d)))(?<secret>${ASSIGNED_VALUE}{12,})(?![A-Za-z0-9_+/=~.(-])`,
      "i",
    ),
  },
  {
    id: "openbao",
    label: "an OpenBao or Vault token",
    prefixes: ["hvs.", "hvb.", "hvr."],
    pattern: /hv[sbr]\.[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "doppler",
    label: "a Doppler token",
    // By kind: personal, service (with its config's name), service account, CLI, SCIM and audit.
    prefixes: ["dp.pt.", "dp.st.", "dp.sa.", "dp.ct.", "dp.scim.", "dp.audit."],
    pattern: /dp\.(?:pt|st|sa|ct|scim|audit)\.(?:[A-Za-z0-9_-]+\.)?[A-Za-z0-9]{40,}/,
  },
  {
    id: "onepassword",
    label: "a 1Password service-account token",
    prefixes: ["ops_"],
    pattern: /ops_eyJ[A-Za-z0-9+/_-]{20,}={0,2}/,
  },
  {
    id: "bitwarden",
    label: "a Bitwarden access token",
    prefixes: ["0."],
    // A version, the access token's id, its client secret and, after the colon, its encryption key.
    pattern: /0\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{20,}:[A-Za-z0-9+/]{20,}={0,2}/,
  },
];

/** One place a shape rule hit: the rule, and the span of the text it hides, `[start, end)`. */
export interface ShapeRuleHit {
  readonly rule: ShapeRuleId;
  readonly start: number;
  readonly end: number;
}

/** Each rule as it is applied: the boundary before its prefix, every match, and where the `secret` group sits. */
const APPLIED = SHAPE_RULES.map((rule) => ({
  id: rule.id,
  expression: new RegExp(`(?<![A-Za-z0-9])(?:${rule.pattern.source})`, `dg${rule.pattern.flags}`),
}));

/**
 * Every shape-rule hit in `text`, by where it starts, rules in their order
 * at one place. Hits of two rules may cover the same text (a GitHub token
 * assigned inline hits both): what is hidden is every hit's span.
 */
export const shapeRuleHits = (text: string): ShapeRuleHit[] => {
  const hits: ShapeRuleHit[] = [];
  for (const { id, expression } of APPLIED) {
    for (const match of text.matchAll(expression)) {
      const [start, end] = match.indices?.groups?.["secret"] ?? [match.index, match.index + match[0].length];
      if (end > start) hits.push({ rule: id, start, end });
    }
  }
  const order = (rule: ShapeRuleId): number => SHAPE_RULE_IDS.indexOf(rule);
  return hits.sort((a, b) => a.start - b.start || order(a.rule) - order(b.rule));
};

/** The rule a value the environment holds as a secret, registered with the scrub registry, is named by. */
export const REGISTERED_VALUE_RULE = "registered-value";

/** What a text held that it may not: a shape rule's hit, or a registered value. */
export const SecretRule = z.enum([...SHAPE_RULE_IDS, REGISTERED_VALUE_RULE]).meta({
  description: "What a refused text held: a shape rule's id, or registered-value for a value the environment holds as a secret.",
});
export type SecretRule = z.infer<typeof SecretRule>;

/**
 * A text the harness would send out held a secret (ADR 0011): an issue's or
 * a pull request's title or body (#316), a memory draft (#90). Named by the
 * rule and the field, never by the value; nothing was sent.
 */
export const SecretShapedError = errorSchema(
  "secret_shaped",
  z.object({
    rule: SecretRule,
    field: z
      .string()
      .min(1)
      .max(128)
      .meta({ description: "The field of the refused write that held it: title or body for an issue or a pull request." }),
  }),
).meta({
  description:
    "A text the harness would send out held a registered value or a shape rule's hit: data names the rule and the field, never the value, and nothing was sent.",
});
export type SecretShapedError = z.infer<typeof SecretShapedError>;
