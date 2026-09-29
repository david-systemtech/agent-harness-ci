import { describe, expect, it } from "vitest";
import { REGISTERED_VALUE_RULE, SHAPE_RULES, SecretRule, SecretShapedError, ShapeRuleId, shapeRuleHits, type ShapeRuleId as ShapeRuleIdType } from "./index.js";

/**
 * The scrub registry's shape rules (key-managers spec, "The scrub
 * registry"; ADR 0011): each rule held to texts it must hit, with the part
 * it hides, and to texts it must leave alone. Every key-shaped value here is
 * put together at run time from a prefix and a low-entropy filler, so no
 * line of this file looks like a key to a secret scanner.
 */

/** `n` characters from `alphabet`, repeated: a filler no scanner takes for a key. */
const fill = (n: number, alphabet = "Fake0Test9"): string => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

/** The parts, joined: a prefix kept apart from its body in the source. */
const joined = (...parts: string[]): string => parts.join("");

const UUID = joined("0b9c7b8e-4a51-4f0c", "-9d55-6f1d3c2b7a10");

/** The texts each rule hits, each with the part it hides, and the texts it must leave alone. */
const CASES: Record<ShapeRuleIdType, { readonly hits: readonly (readonly [text: string, hidden: string])[]; readonly misses: readonly string[] }> = (() => {
  const anthropic = joined("sk-", "ant-", "api03-", fill(90, "Fake0Test9_-"));
  const anthropicAdmin = joined("sk-", "ant-", "admin01-", fill(90));
  const openaiLegacy = joined("s", "k-", fill(48));
  const openaiProject = joined("s", "k-", "proj-", fill(120, "Fake0-Test9_"));
  const openrouter = joined("s", "k-", "or-v1-", fill(64, "abc0123def"));
  const aws = joined("AK", "IA", fill(16, "TEST0ONLY9"));
  const awsSession = joined("AS", "IA", fill(16, "TEST0ONLY9"));
  const googleKey = joined("AI", "za", fill(35, "Fake0Test9_-"));
  const googleSecret = joined("GOC", "SPX-", fill(28));
  const googleAccess = joined("ya", "29.", fill(60, "Fake0Test9_-"));
  const githubClassic = joined("gh", "p_", fill(36));
  const githubServer = joined("gh", "s_", fill(36));
  const githubFine = joined("github", "_pat_", fill(82, "Fake0Test9_"));
  const pemBody = `${fill(64)}\n${fill(64)}\n${fill(20)}==`;
  const pem = joined("-----BEGIN ", "RSA PRIVATE KEY-----\n", pemBody, "\n-----END ", "RSA PRIVATE KEY-----");
  const pemOpenSsh = joined("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", pemBody, "\n-----END ", "OPENSSH PRIVATE KEY-----");
  const pemCut = joined("-----BEGIN ", "PRIVATE KEY-----\n", fill(64), "\n");
  const bearer = joined("eyJ", fill(30), ".", fill(40), ".", fill(20, "Fake0Test9_-"));
  const opaque = fill(40, "Fake0Test9~+/");
  const bao = joined("hv", "s.", fill(90, "Fake0Test9_-"));
  const baoBatch = joined("hv", "b.", fill(130));
  const baoRecovery = joined("hv", "r.", fill(60));
  const dopplerPersonal = joined("dp", ".pt.", fill(43));
  const dopplerService = joined("dp", ".st.", "dev.", fill(40));
  const dopplerAccount = joined("dp", ".sa.", fill(43));
  const dopplerCli = joined("dp", ".ct.", fill(43));
  const onePassword = joined("ops", "_eyJ", fill(250, "Fake0Test9+/"), "=");
  const bitwarden = joined("0.", UUID, ".", fill(30), ":", fill(24, "Fake0Test9+/"), "==");
  const assigned = fill(24, "Fake0Test9");
  return {
    anthropic: {
      hits: [
        [`export ANTHROPIC_API_KEY=${anthropic}`, anthropic],
        [`{"key":"${anthropicAdmin}"}`, anthropicAdmin],
      ],
      misses: [joined("sk-", "ant-", "short"), `x${anthropic}`, `use the sk-ant- prefix for keys`],
    },
    "openai-style": {
      hits: [
        [`OPENAI_KEY: ${openaiLegacy}`, openaiLegacy],
        [`-H "Authorization: Key ${openaiProject}"`, openaiProject],
        [`key ${openrouter} expired`, openrouter],
      ],
      misses: [
        "the sk-learn-preprocessing-pipeline package",
        "run the task-runner-for-long-queues-and-other-work job",
        "open desk-booking-service-for-the-whole-team",
        `kubectl rollout restart deploy/payments-sk-${fill(24, "abc0123def")}`,
        `ask${fill(30)}`,
        joined("s", "k-", fill(12)),
      ],
    },
    aws: {
      hits: [
        [`aws configure set aws_access_key_id ${aws}`, aws],
        [`"AccessKeyId": "${awsSession}"`, awsSession],
      ],
      misses: [`x${aws}`, `${aws}X`, joined("AK", "IA", fill(12, "TEST0ONLY9")), joined("AK", "IA", fill(16, "test0only9"))],
    },
    google: {
      hits: [
        [`?key=${googleKey}&alt=json`, googleKey],
        [`client_secret ${googleSecret}`, googleSecret],
        [`access ${googleAccess}`, googleAccess],
      ],
      misses: [`x${googleKey}`, joined("AI", "za", fill(20)), joined("ya", "29.", "short")],
    },
    github: {
      hits: [
        [`GITHUB_TOKEN=${githubClassic}`, githubClassic],
        [`https://x-access-token:${githubServer}@github.com/david/bank.git`, githubServer],
        [`token ${githubFine}`, githubFine],
      ],
      misses: [`x${githubClassic}`, joined("gh", "p_", fill(20)), "rename ghp_ to gho_ in the docs"],
    },
    "private-key": {
      hits: [
        [`key:\n${pem}\ndone`, pem],
        [pemOpenSsh, pemOpenSsh],
        [`cut short: ${pemCut}`, pemCut],
      ],
      misses: [joined("-----BEGIN ", "CERTIFICATE-----\n", fill(64), "\n-----END ", "CERTIFICATE-----"), joined("-----BEGIN ", "PUBLIC KEY-----"), "a private key belongs in the key manager"],
    },
    bearer: {
      hits: [
        [`Authorization: Bearer ${bearer}`, bearer],
        [`authorization: bearer ${opaque}`, opaque],
      ],
      misses: ["the bearer of this letter is welcome", "Bearer [redacted]", `xBearer ${opaque}`, "Bearer short-one"],
    },
    "key-assignment": {
      hits: [
        [`DATABASE_PASSWORD=${assigned}`, assigned],
        [`{"api_key": "${assigned}"}`, assigned],
        [`client_secret: ${assigned}`, assigned],
        [`curl -H "X-Api-Key: ${assigned}" https://example.com`, assigned],
        [`https://example.com/callback?access_token=${assigned}&state=1`, assigned],
        [`--token=${assigned}`, assigned],
        [`password = '${fill(14, "horse")}'`, fill(14, "horse")],
      ],
      misses: [
        "readonly token: ForgeCredential;",
        "const token = options.forgeAccountToken;",
        "const token = readTheTokenFromTheVault();",
        "token=$GITHUB_TOKEN",
        "max_tokens=4096",
        "password: undefined",
        "token: [redacted]",
        "the token = 2 times",
        `mytoken=${assigned}`,
      ],
    },
    openbao: {
      hits: [
        [`VAULT_TOKEN=${bao}`, bao],
        [`batch ${baoBatch}`, baoBatch],
        [`recovery ${baoRecovery}`, baoRecovery],
      ],
      misses: [`x${bao}`, joined("hv", "s.", "short"), "the hvs. prefix marks a service token"],
    },
    doppler: {
      hits: [
        [`DOPPLER_TOKEN=${dopplerPersonal}`, dopplerPersonal],
        [`service ${dopplerService}`, dopplerService],
        [`account ${dopplerAccount}`, dopplerAccount],
        [`cli ${dopplerCli}`, dopplerCli],
      ],
      misses: [`x${dopplerPersonal}`, joined("dp", ".pt.", "short"), joined("dp", ".xx.", fill(43))],
    },
    onepassword: {
      hits: [[`OP_SERVICE_ACCOUNT_TOKEN=${onePassword}`, onePassword]],
      misses: [`x${onePassword}`, joined("ops", "_", fill(40)), "ops_eyJ is how the token starts"],
    },
    bitwarden: {
      hits: [[`BWS_ACCESS_TOKEN=${bitwarden}`, bitwarden]],
      misses: [`1${bitwarden}`, joined("0.", UUID), `version 0.${UUID.slice(0, 8)} shipped`],
    },
  };
})();

/** What `text` shows once every shape-rule hit is replaced, for reading a table's failures. */
const hiddenParts = (text: string): { rule: string; hidden: string }[] => shapeRuleHits(text).map(({ rule, start, end }) => ({ rule, hidden: text.slice(start, end) }));

describe("the shape rules", () => {
  it("are data: one rule per id, each with a label, the prefixes it is anchored on and its pattern, and no id twice", () => {
    expect(SHAPE_RULES.map((rule) => rule.id)).toEqual(ShapeRuleId.options);
    for (const rule of SHAPE_RULES) {
      expect(rule.label, rule.id).not.toBe("");
      expect(rule.prefixes.length, rule.id).toBeGreaterThan(0);
      expect(rule.pattern.flags.replace("i", ""), rule.id).toBe("");
    }
  });

  it("cover Anthropic, OpenAI-style, AWS, Google and GitHub keys, PEM private keys, bearer tokens, inline key assignments, OpenBao and Vault, Doppler, 1Password and Bitwarden tokens", () => {
    expect(ShapeRuleId.options).toEqual([
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
    ]);
    const prefixes = Object.fromEntries(SHAPE_RULES.map((rule) => [rule.id, rule.prefixes]));
    expect(prefixes["openbao"]).toEqual(["hvs.", "hvb.", "hvr."]);
    expect(prefixes["doppler"]).toEqual(["dp.pt.", "dp.st.", "dp.sa.", "dp.ct.", "dp.scim.", "dp.audit."]);
  });

  describe.each(SHAPE_RULES.map((rule) => [rule.id, rule] as const))("%s", (id, rule) => {
    const cases = CASES[id];

    it("hides what it hits, and only that: another rule may hit the same text, as a key assigned inline does", () => {
      expect(cases.hits.length).toBeGreaterThan(0);
      for (const [text, hidden] of cases.hits) expect(hiddenParts(text).filter((hit) => hit.rule === id), text).toEqual([{ rule: id, hidden }]);
    });

    it("leaves its misses alone, glued to a word before its prefix among them: no rule hits them", () => {
      expect(cases.misses.length).toBeGreaterThan(0);
      for (const text of cases.misses) expect(hiddenParts(text), text).toEqual([]);
    });

    it("is anchored on the prefixes it names: taken out of a text it hits, it hits nothing there", () => {
      for (const [text] of cases.hits) {
        const flags = rule.pattern.flags.includes("i") ? "gi" : "g";
        const stripped = rule.prefixes.reduce((left, prefix) => left.replace(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"), flags), ""), text);
        expect(hiddenParts(stripped).filter((hit) => hit.rule === id), stripped).toEqual([]);
      }
    });
  });

  it("leave alone what only looks random: base64 tool output, a kebab-case name ending in sk-, hashes and ids", () => {
    const base64 = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
    const glued = `QkFTRTY0${joined("AK", "IA")}${fill(16, "TEST0ONLY9")}Zm9v${joined("AI", "za")}${fill(35)}YmFy`;
    for (const text of [
      base64,
      `$ base64 < image.png\n${base64.match(/.{1,76}/g)?.join("\n")}`,
      glued,
      "the rollout-for-desk- and risk-sk- names",
      "name: build-and-mask-",
      "commit 9fceae2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
      `session ${UUID} ended`,
      "sha256:4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b",
      "Read the token from the key manager; never paste a password into a file.",
    ]) {
      expect(hiddenParts(text), text.slice(0, 80)).toEqual([]);
    }
  });

  it("answer each hit's span, in order of where it starts, the key-assignment rule and a bearer token hiding only the value", () => {
    const github = joined("gh", "p_", fill(36));
    const bearer = fill(32);
    const text = `Authorization: Bearer ${bearer}\nGITHUB_TOKEN=${github}`;
    expect(hiddenParts(text)).toEqual([
      { rule: "bearer", hidden: bearer },
      { rule: "github", hidden: github },
      { rule: "key-assignment", hidden: github },
    ]);
  });
});

describe("secret_shaped", () => {
  it("names the rule, a shape rule's id or registered-value, and the field, never the value", () => {
    const error = { code: "secret_shaped", message: "The issue's body holds a GitHub token: take it out.", data: { rule: "github", field: "body" } };
    expect(SecretShapedError.parse(error)).toEqual(error);
    expect(SecretShapedError.parse({ ...error, data: { rule: REGISTERED_VALUE_RULE, field: "title" } }).data.rule).toBe("registered-value");
    expect(SecretShapedError.safeParse({ ...error, data: { rule: "entropy", field: "body" } }).success).toBe(false);
    expect(SecretShapedError.safeParse({ ...error, data: { rule: "github" } }).success).toBe(false);
    expect(SecretShapedError.safeParse({ ...error, data: { rule: "github", field: "" } }).success).toBe(false);
    expect(SecretRule.options).toEqual([...ShapeRuleId.options, "registered-value"]);
  });
});
