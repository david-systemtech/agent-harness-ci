import { describe, expect, it } from "vitest";
import { CLIENT_KINDS, Ceiling, SCOPES, ScopeSet, scopesInWords } from "./index.js";

describe("scopes", () => {
  it("are the five the env spec names", () => {
    expect(SCOPES).toEqual(["read", "sessions:write", "runs:drive", "terminal", "admin"]);
  });

  it("are said in words in their own order, and an empty list as no scope", () => {
    expect(scopesInWords(SCOPES)).toBe("every scope");
    expect(scopesInWords(["read"])).toBe("read");
    expect(scopesInWords(["runs:drive", "read", "sessions:write"])).toBe("read, sessions:write and runs:drive");
    expect(scopesInWords([])).toBe("no scope");
  });

  it("are granted as a non-empty set", () => {
    expect(ScopeSet.safeParse(["read"]).success).toBe(true);
    expect(ScopeSet.safeParse([]).success).toBe(false);
    expect(ScopeSet.safeParse(["read", "read"]).success).toBe(false);
  });
});

describe("a client session", () => {
  it("is one of four kinds", () => {
    expect(CLIENT_KINDS).toEqual(["desktop", "tui", "web", "program"]);
  });

  it("has a ceiling whose values the permissions workstream fixes, so any non-empty name for now", () => {
    expect(Ceiling.safeParse("acceptEdits").success).toBe(true);
    expect(Ceiling.safeParse("").success).toBe(false);
  });
});
