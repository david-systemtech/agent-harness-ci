import { describe, expect, it } from "vitest";
import { createScrubRegistry } from "./registry.js";

/**
 * The scrub registry at its lower seam (key-managers spec, "Testing
 * Decisions"): registration and its release, the reference counts, the
 * encoded forms, the short-value rule and overlapping values, seen through
 * what `scrub` makes of a text.
 */

const HELD = "a-value-its-owner-holds";

describe("the scrub registry", () => {
  it("replaces a registered value with [redacted] until its release", () => {
    const registry = createScrubRegistry();
    const release = registry.register(HELD, { owner: "test:one" });
    expect(registry.scrub(`export VAULT_TOKEN=${HELD}; echo ${HELD}`)).toBe("export VAULT_TOKEN=[redacted]; echo [redacted]");
    release();
    expect(registry.scrub(`echo ${HELD}`)).toBe(`echo ${HELD}`);
  });

  it("keeps a value two owners registered until both have released it, however often one releases", () => {
    const registry = createScrubRegistry();
    const vault = registry.register(HELD, { owner: "vault:forge-origin" });
    const run = registry.register(HELD, { owner: "run:r1" });
    run();
    run();
    expect(registry.scrub(HELD)).toBe("[redacted]");
    vault();
    expect(registry.scrub(HELD)).toBe(HELD);
  });

  it("scrubs the value's percent-encoded and JSON-escaped forms like the value", () => {
    const registry = createScrubRegistry();
    const value = 'p@ss/w0rd+"quoted"\\end';
    registry.register(value, { owner: "test:encoded" });
    expect(registry.scrub("https://bot:p%40ss%2Fw0rd%2B%22quoted%22%5Cend@git.example.com/org/repo.git")).toBe("https://bot:[redacted]@git.example.com/org/repo.git");
    expect(registry.scrub('{"password":"p@ss/w0rd+\\"quoted\\"\\\\end"}')).toBe('{"password":"[redacted]"}');
    expect(registry.scrub(`raw ${value}`)).toBe("raw [redacted]");
  });

  it("scrubs a form the owner adds, and its encoded forms, while the value is held, and lets it go with the value", () => {
    const registry = createScrubRegistry();
    const basic = Buffer.from(`david:${HELD}`).toString("base64");
    const release = registry.register(HELD, { owner: "forge:git.example.com", forms: [basic] });
    expect(registry.scrub(`Authorization: Basic ${basic}`)).toBe("Authorization: Basic [redacted]");
    expect(registry.scrub(`auth=${encodeURIComponent(basic)}`)).toBe("auth=[redacted]");
    release();
    expect(registry.scrub(`Authorization: Basic ${basic}`)).toBe(`Authorization: Basic ${basic}`);
  });

  it("matches a value under eight characters only whole, between non-alphanumerics", () => {
    const registry = createScrubRegistry();
    registry.register("k3y42", { owner: "test:short" });
    expect(registry.scrub("k3y42")).toBe("[redacted]");
    expect(registry.scrub("pin=k3y42; (k3y42) FOO_k3y42 k3y42.")).toBe("pin=[redacted]; ([redacted]) FOO_[redacted] [redacted].");
    // Inside a word, a number or another script's letters it is left as it is.
    expect(registry.scrub("xk3y42 k3y421 k3y42é Ωk3y42 k3y42٣")).toBe("xk3y42 k3y421 k3y42é Ωk3y42 k3y42٣");
    // A letter outside the basic plane is a letter too.
    expect(registry.scrub("𝐀k3y42 k3y42𝐀 🙂k3y42")).toBe("𝐀k3y42 k3y42𝐀 🙂[redacted]");
  });

  it("matches a value of eight characters or more anywhere, inside words too", () => {
    const registry = createScrubRegistry();
    registry.register("k3y42abc", { owner: "test:eight" });
    expect(registry.scrub("xk3y42abcx")).toBe("x[redacted]x");
  });

  it("holds each encoded form of a short value to the rule by its own length", () => {
    const registry = createScrubRegistry();
    // Seven characters; percent-encoded it is thirteen, a%2Fb%20c%2Fd, and matched anywhere.
    registry.register("a/b c/d", { owner: "test:short-encoded" });
    expect(registry.scrub("xa/b c/dx")).toBe("xa/b c/dx");
    expect(registry.scrub("q=xa%2Fb%20c%2Fdx")).toBe("q=x[redacted]x");
  });

  describe("overlapping values", () => {
    it("replaces two values that overlap in a text as one, leaving nothing of either", () => {
      const registry = createScrubRegistry();
      registry.register("secret-token-123", { owner: "test:a" });
      registry.register("token-123-extra", { owner: "test:b" });
      expect(registry.scrub("xx secret-token-123-extra yy")).toBe("xx [redacted] yy");
      // Registered the other way round, the answer is the same.
      const reversed = createScrubRegistry();
      reversed.register("token-123-extra", { owner: "test:b" });
      reversed.register("secret-token-123", { owner: "test:a" });
      expect(reversed.scrub("xx secret-token-123-extra yy")).toBe("xx [redacted] yy");
    });

    it("replaces a value inside a longer one with the longer one", () => {
      const registry = createScrubRegistry();
      registry.register("abcdefgh", { owner: "test:inner" });
      registry.register("abcdefgh-ijklmnop", { owner: "test:outer" });
      expect(registry.scrub("[abcdefgh-ijklmnop] [abcdefgh]")).toBe("[[redacted]] [[redacted]]");
    });

    it("replaces a value whose occurrences overlap themselves as one", () => {
      const registry = createScrubRegistry();
      registry.register("abababab", { owner: "test:self" });
      expect(registry.scrub("x ababababab x")).toBe("x [redacted] x");
    });

    it("replaces two values side by side each on its own", () => {
      const registry = createScrubRegistry();
      registry.register("AAAAAAAA", { owner: "test:a" });
      registry.register("BBBBBBBB", { owner: "test:b" });
      expect(registry.scrub("AAAAAAAABBBBBBBB")).toBe("[redacted][redacted]");
    });

    it("replaces a value's form overlapping another value", () => {
      const registry = createScrubRegistry();
      registry.register("p@ssword1", { owner: "test:a" });
      registry.register("40ssword1-and-more", { owner: "test:b" });
      expect(registry.scrub("u=p%40ssword1-and-more")).toBe("u=[redacted]");
    });
  });

  it("registers nothing for an empty value or form", () => {
    const registry = createScrubRegistry();
    const release = registry.register("", { owner: "test:empty", forms: [""] });
    expect(registry.scrub("text stays as it is")).toBe("text stays as it is");
    release();
  });

  it("counts one owner's two registrations of a value as two", () => {
    const registry = createScrubRegistry();
    const first = registry.register(HELD, { owner: "vault:k" });
    const second = registry.register(HELD, { owner: "vault:k" });
    first();
    expect(registry.scrub(HELD)).toBe("[redacted]");
    second();
    expect(registry.scrub(HELD)).toBe(HELD);
  });
});
