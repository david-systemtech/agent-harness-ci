import { describe, expect, it } from "vitest";
import { createScrubRegistry } from "./registry.js";

/**
 * The scrub registry at its lower seam (key-managers spec, "Testing
 * Decisions"): registration and its release, the reference counts, the
 * encoded forms, the short-value rule and overlapping values, seen through
 * what `scrub` makes of a text; the shape rules beside registered values in
 * `scrubOutput` and `check`; and a stream's held-back tail, with values
 * registered and released while it holds one.
 */

const HELD = "a-value-its-owner-holds";

/** `n` characters of a low-entropy filler, so no line here looks like a key to a secret scanner. */
const fill = (n: number): string => "Fake0Test9".repeat(Math.ceil(n / 10)).slice(0, n);

/** A GitHub-shaped token, put together at run time. */
const GITHUB_SHAPED = ["gh", "p_", fill(36)].join("");

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

describe("scrubOutput: registered values, then shape rules", () => {
  it("replaces registered values and shape-rule hits with [redacted], where scrub replaces only the values", () => {
    const registry = createScrubRegistry();
    registry.register(HELD, { owner: "test:one" });
    const text = `pushed with ${GITHUB_SHAPED} as ${HELD}`;
    expect(registry.scrubOutput(text)).toBe("pushed with [redacted] as [redacted]");
    expect(registry.scrub(text)).toBe(`pushed with ${GITHUB_SHAPED} as [redacted]`);
  });

  it("hides only the value of a key assigned inline or a bearer token, keeping the name", () => {
    const registry = createScrubRegistry();
    const value = fill(24);
    expect(registry.scrubOutput(`DATABASE_PASSWORD=${value}\nAuthorization: Bearer ${value}`)).toBe("DATABASE_PASSWORD=[redacted]\nAuthorization: Bearer [redacted]");
  });

  it("replaces a registered value and a shape-rule hit that overlap as one, leaving nothing of either", () => {
    const registry = createScrubRegistry();
    // A registered value that ends inside a GitHub-shaped token: once it is gone, the token's rest would no longer be token-shaped.
    registry.register(`run-${GITHUB_SHAPED.slice(0, 12)}`, { owner: "test:head" });
    expect(registry.scrubOutput(`x run-${GITHUB_SHAPED} y`)).toBe("x [redacted] y");
    // And a registered value that begins inside one.
    const tail = createScrubRegistry();
    tail.register(`${GITHUB_SHAPED.slice(20)}-and-more`, { owner: "test:tail" });
    expect(tail.scrubOutput(`x ${GITHUB_SHAPED}-and-more y`)).toBe("x [redacted] y");
  });

  it("leaves text it has scrubbed as it is", () => {
    const registry = createScrubRegistry();
    registry.register(HELD, { owner: "test:one" });
    const once = registry.scrubOutput(`GITHUB_TOKEN=${GITHUB_SHAPED} ${HELD} Authorization: Bearer ${fill(20)}`);
    expect(registry.scrubOutput(once)).toBe(once);
  });
});

describe("check: whether a text holds a registered value or a shape-rule hit", () => {
  it("names registered-value for a registered value, in any of its forms, before any shape rule", () => {
    const registry = createScrubRegistry();
    registry.register(GITHUB_SHAPED, { owner: "forge:github" });
    expect(registry.check(`the token ${GITHUB_SHAPED}`)).toBe("registered-value");
    expect(registry.check(`q=${encodeURIComponent(HELD)}`)).toBeNull();
    registry.register(HELD, { owner: "test:one" });
    expect(registry.check(`private key and q=${encodeURIComponent(HELD)}`)).toBe("registered-value");
  });

  it("names the first shape rule hit in the text, and answers null for a text with neither", () => {
    const registry = createScrubRegistry();
    expect(registry.check(`first Authorization: Bearer ${fill(20)}, then ${GITHUB_SHAPED}`)).toBe("bearer");
    expect(registry.check(`only ${GITHUB_SHAPED}`)).toBe("github");
    expect(registry.check("the task-runner-for-long-queues and a desk-sk- name")).toBeNull();
  });
});

describe("a stream: a tail held back while it could begin a registered value", () => {
  const SPLIT = "alpha-secret-value-1";

  it("holds back a tail that is a prefix of a registered value, and shows the value as [redacted] once the rest comes", () => {
    const registry = createScrubRegistry();
    registry.register(SPLIT, { owner: "test:split" });
    const stream = registry.stream();
    expect(stream.push("echo alpha-sec")).toBe("echo ");
    expect(stream.holding).toBe(true);
    expect(stream.push("ret-value-1 done\r\n")).toBe("[redacted] done\r\n");
    expect(stream.holding).toBe(false);
  });

  it("shows at once a text whose tail begins no registered value", () => {
    const registry = createScrubRegistry();
    registry.register(SPLIT, { owner: "test:split" });
    const stream = registry.stream();
    expect(stream.push("plain output\r\n$ ")).toBe("plain output\r\n$ ");
    expect(stream.holding).toBe(false);
    expect(stream.push(`and ${SPLIT} whole`)).toBe("and [redacted] whole");
  });

  it("answers what it holds on a flush, scrubbed, and holds nothing after", () => {
    const registry = createScrubRegistry();
    registry.register(SPLIT, { owner: "test:split" });
    const stream = registry.stream();
    expect(stream.push("x alpha-")).toBe("x ");
    expect(stream.flush()).toBe("alpha-");
    expect(stream.holding).toBe(false);
    expect(stream.flush()).toBe("");
  });

  it("scrubs a value registered while a prefix of it is held back, once the rest comes", () => {
    const registry = createScrubRegistry();
    registry.register(SPLIT, { owner: "test:split" });
    const stream = registry.stream();
    expect(stream.push("x alpha-sec")).toBe("x ");
    registry.register("alpha-second-value-2", { owner: "test:later" });
    expect(stream.push("ond-value-2 y")).toBe("[redacted] y");
  });

  it("lets a tail go as it is once the value it could begin is released during the hold", () => {
    const registry = createScrubRegistry();
    const release = registry.register(SPLIT, { owner: "test:split" });
    const stream = registry.stream();
    expect(stream.push("x alpha-sec")).toBe("x ");
    release();
    expect(stream.push("ret-value-1 y")).toBe(`${SPLIT} y`);
    expect(stream.holding).toBe(false);
    // A flush during a hold whose value was released answers the tail as it is.
    const again = registry.register(SPLIT, { owner: "test:split" });
    expect(stream.push("alpha")).toBe("");
    again();
    expect(stream.flush()).toBe("alpha");
  });

  it("holds a whole value back with a tail it overlaps, so no part of either is shown", () => {
    const registry = createScrubRegistry();
    registry.register("abcdefgh", { owner: "test:inner" });
    registry.register("efghXYZW-more", { owner: "test:overlapping" });
    const stream = registry.stream();
    expect(stream.push("x abcdefgh")).toBe("x ");
    expect(stream.push("XYZW-more y")).toBe("[redacted] y");
  });

  it("holds a tail of a short value only where the value could stand alone", () => {
    const registry = createScrubRegistry();
    registry.register("k3y42", { owner: "test:short" });
    const stream = registry.stream();
    expect(stream.push("pin=k3y")).toBe("pin=");
    expect(stream.push("42;")).toBe("[redacted];");
    expect(stream.push(" xk3y")).toBe(" xk3y");
    expect(stream.holding).toBe(false);
  });

  it("holds a tail that begins a value's encoded form", () => {
    const registry = createScrubRegistry();
    registry.register("p@ss/w0rd-long", { owner: "test:encoded" });
    const stream = registry.stream();
    expect(stream.push("url=https://bot:p%40ss%2F")).toBe("url=https://bot:");
    expect(stream.push("w0rd-long@host")).toBe("[redacted]@host");
  });

  it("scrubs registered values only: a shape-rule hit is the terminal's own", () => {
    const registry = createScrubRegistry();
    const stream = registry.stream();
    expect(stream.push(`echo ${GITHUB_SHAPED}`)).toBe(`echo ${GITHUB_SHAPED}`);
  });
});
