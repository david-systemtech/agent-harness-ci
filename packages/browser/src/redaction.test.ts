// @vitest-environment jsdom
import { SHAPE_RULES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { TOKEN_SHAPES, redactTokens, redactedFieldValue, secretField } from "./index.js";

/**
 * Redaction (browser spec, "Model-boundary hygiene"): token-shaped strings in
 * page text, and the fields whose values are never read. Every key-shaped
 * value here is put together at run time from a prefix and a low-entropy
 * filler, so no line of this file looks like a key to a secret scanner.
 */

/** `n` characters from `alphabet`, repeated: a filler no scanner takes for a key. */
const fill = (n: number, alphabet = "Fake0Test9"): string => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

/** The parts, joined: a prefix kept apart from its body in the source. */
const joined = (...parts: string[]): string => parts.join("");

const jwtHeader = joined("ey", "J", fill(30, "Fake0Test9_-"));
const jwtPayload = joined("ey", "J", fill(60, "Fake0Test9_-"));
const jwt = joined(jwtHeader, ".", jwtPayload, ".", fill(43, "Fake0Test9_-"));
const unsignedJwt = joined(jwtHeader, ".", jwtPayload, ".");
const pem = joined("-----BEGIN ", "RSA PRIVATE KEY-----\n", `${fill(64)}\n${fill(64)}\n${fill(20)}==`, "\n-----END ", "RSA PRIVATE KEY-----");

describe("token-shaped strings in page text", () => {
  /** Each text, and what it reads once redacted. */
  const HITS: readonly (readonly [string, string])[] = [
    [`Your key is ${joined("sk-", "ant-", "api03-", fill(90, "Fake0Test9_-"))} keep it safe`, "Your key is [redacted: an Anthropic API key] keep it safe"],
    [`OPENAI_API_KEY ${joined("s", "k-", "proj-", fill(120, "Fake0-Test9_"))}`, "OPENAI_API_KEY [redacted: an OpenAI-style API key]"],
    [`Access key id: ${joined("AK", "IA", fill(16, "TEST0ONLY9"))}.`, "Access key id: [redacted: an AWS access key]."],
    [`cloned with ${joined("gh", "p_", fill(36))} yesterday`, "cloned with [redacted: a GitHub token] yesterday"],
    [`session=${jwt}; path=/`, "session=[redacted: a JSON web token]; path=/"],
    [`an unsigned token ${unsignedJwt} here`, "an unsigned token [redacted: a JSON web token] here"],
    [`The key:\n${pem}\nends here.`, "The key:\n[redacted: a PEM private key]\nends here."],
    [`Authorization: Bearer ${jwt}`, "Authorization: Bearer [redacted: a bearer token]"],
    [`vault ${joined("hv", "s.", fill(90, "Fake0Test9_-"))}`, "vault [redacted: an OpenBao or Vault token]"],
  ];

  it.each(HITS)("replaces each with a marker naming the kind removed: %s", (text, redacted) => {
    expect(redactTokens(text)).toBe(redacted);
  });

  /** Texts that only look random, and are kept as written. */
  const MISSES: readonly string[] = [
    // A kebab-case word ending in sk-, before a long run of letters and digits.
    `kubectl rollout restart deploy/payments-sk-${fill(24, "abc0123def")}`,
    `the desk-${fill(30)} room`,
    // Base64 text: a picture's bytes, and JSON written as base64 with no dots between its parts.
    Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37 + 11) % 256)).toString("base64"),
    Buffer.from(JSON.stringify({ page: 2, size: 20, sort: "newest" })).toString("base64url"),
    // A UUID, a commit and a hash.
    "request 0b9c7b8e-4a51-4f0c-9d55-6f1d3c2b7a10 failed",
    "commit 9fceae2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
    // A JSON web token's parts spoken of, a dotted name and a header alone.
    "a JSON web token starts eyJ and has three parts",
    `${jwtHeader}.short.x`,
    "Read the token from the key manager; never paste a password into a page.",
  ];

  it.each(MISSES)("leaves alone what only looks random: %s", (text) => {
    expect(redactTokens(text)).toBe(text);
  });

  it("replaces overlapping hits with one marker, and leaves a redacted text as it is", () => {
    const github = joined("gh", "p_", fill(36));
    const text = `GITHUB_TOKEN=${github} and ${jwt}`;
    const redacted = redactTokens(text);
    expect(redacted).toBe("GITHUB_TOKEN=[redacted: a GitHub token] and [redacted: a JSON web token]");
    expect(redactTokens(redacted)).toBe(redacted);
  });

  it("reads the scrub registry's shape rules as they are and adds only what they lack, so each prefix is in one table", () => {
    expect(TOKEN_SHAPES.slice(0, SHAPE_RULES.length)).toEqual(SHAPE_RULES);
    const added = TOKEN_SHAPES.slice(SHAPE_RULES.length);
    expect(added.map((shape) => shape.id)).toEqual(["jwt"]);
    const prefixes = TOKEN_SHAPES.flatMap((shape) => shape.prefixes.map((prefix) => prefix.toLowerCase()));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(new Set(TOKEN_SHAPES.map((shape) => shape.id)).size).toBe(TOKEN_SHAPES.length);
  });
});

describe("the fields whose values are never read", () => {
  it("names a password input's value, whatever the type attribute's case", () => {
    expect(secretField({ type: "password" })).toBe("password");
    expect(secretField({ type: "PASSWORD", autocomplete: "off" })).toBe("password");
  });

  it("names a field whose autocomplete is a cc- value, among the attribute's other tokens and in any case", () => {
    for (const autocomplete of ["cc-number", "cc-exp", "cc-csc", "cc-name", "CC-Exp-Month", "section-blue billing cc-number", "cc-number webauthn"]) {
      expect(secretField({ type: "text", autocomplete }), autocomplete).toBe("payment-card");
    }
    expect(secretField({ type: "select-one", autocomplete: "cc-exp-year" })).toBe("payment-card");
  });

  it("names a field whose autocomplete is one-time-code", () => {
    expect(secretField({ type: "text", autocomplete: "one-time-code" })).toBe("one-time-code");
    expect(secretField({ type: "number", autocomplete: " One-Time-Code " })).toBe("one-time-code");
  });

  it("names a password field its page shows as text, by its current-password or new-password autocomplete", () => {
    expect(secretField({ type: "text", autocomplete: "current-password" })).toBe("password");
    expect(secretField({ type: "text", autocomplete: "section-signup new-password" })).toBe("password");
  });

  it("reads every other field", () => {
    expect(secretField({ type: "text" })).toBeNull();
    expect(secretField({})).toBeNull();
    expect(secretField({ type: null, autocomplete: null })).toBeNull();
    for (const autocomplete of ["email", "username", "off", "on", "acc-number", "tel", "one-time", "postal-code"]) {
      expect(secretField({ type: "text", autocomplete }), autocomplete).toBeNull();
    }
  });

  it("takes a form element as it is, by its type and its autocomplete attribute", () => {
    const input = document.createElement("input");
    input.type = "password";
    expect(secretField(input)).toBe("password");
    const card = document.createElement("input");
    card.setAttribute("autocomplete", "cc-number");
    expect(secretField(card)).toBe("payment-card");
    const code = document.createElement("textarea");
    code.setAttribute("autocomplete", "one-time-code");
    expect(secretField(code)).toBe("one-time-code");
    expect(secretField(document.createElement("select"))).toBeNull();
  });

  it("gives a marker naming what was removed, in place of the value", () => {
    expect(redactedFieldValue("password")).toBe("[redacted: a password]");
    expect(redactedFieldValue("payment-card")).toBe("[redacted: a payment card detail]");
    expect(redactedFieldValue("one-time-code")).toBe("[redacted: a one-time code]");
  });
});
