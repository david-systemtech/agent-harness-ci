import type { EnvironmentView } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { abbreviationOf, badgesOf, glyphOf } from "./badge.js";

/**
 * The environment badge on every rail row (ADR 0005; docs/specs/tui.md, "The
 * rail"): the environment's colour and icon, and a two-letter abbreviation of
 * its name unique among the environments listed; and the activity glyph.
 */

const view = (name: string | null, fields: Partial<EnvironmentView> = {}): EnvironmentView =>
  ({ environmentId: `id-${name ?? "placeholder"}`, name, icon: null, colour: null, ...fields }) as EnvironmentView;

describe("the abbreviation", () => {
  it("takes the first letters of the first two words, else the first two letters, in capitals", () => {
    expect(abbreviationOf("desk")).toBe("DE");
    expect(abbreviationOf("SYSTEM-SERVER")).toBe("SS");
    expect(abbreviationOf("seth's laptop")).toBe("SL");
    expect(abbreviationOf("x")).toBe("X");
    expect(abbreviationOf(null)).toBe("TM");
  });
});

describe("the badges of the environments listed", () => {
  it("give each environment its own colour, icon and an abbreviation no other has", () => {
    const badges = badgesOf([view("desk"), view("dev box"), view("laptop"), view("develop")]);
    expect([...badges.values()].map((b) => b.abbreviation)).toEqual(["DE", "DB", "LA", "DV"]);
    expect(new Set([...badges.values()].map((b) => b.colour)).size).toBe(4);
    expect(badges.get("id-desk")?.icon).toBe("●");
  });

  it("keep the circle and a colour by place whatever icon and colour the environment names, until the terminal UI maps them (#327)", () => {
    const badges = badgesOf([view("desk", { colour: "amber", icon: "laptop" }), view("tower", { colour: "red", icon: "server" })]);
    expect(badges.get("id-desk")).toEqual(badgesOf([view("desk")]).get("id-desk"));
    expect(badges.get("id-desk")).toEqual({ icon: "●", abbreviation: "DE", colour: "cyan" });
    expect(badges.get("id-tower")).toEqual({ icon: "●", abbreviation: "TO", colour: "magenta" });
  });

  it("say this machine for the placeholder", () => {
    expect(badgesOf([view(null)]).get("id-placeholder")?.abbreviation).toBe("TM");
  });

  it("take a digit after the first letter once the letters run out, so two names with the same letters differ", () => {
    const badges = badgesOf([view("ab"), view("a b"), view("A-B")]);
    expect([...badges.values()].map((b) => b.abbreviation)).toEqual(["AB", "A2", "A3"]);
  });

  it("fall back to ?? for a name with no letter or digit, rather than an empty abbreviation, shared by every such name", () => {
    expect(badgesOf([view("---")]).get("id----")?.abbreviation).toBe("??");
    expect(abbreviationOf("···")).toBe("");
    expect([...badgesOf([view("---"), view("···")]).values()].map((b) => b.abbreviation)).toEqual(["??", "??"]);
  });

  it("share the plain abbreviation past nine names of the same letters, the digits spent", () => {
    const names = ["ab", "a b", "a-b", "a.b", "a_b", "AB", "Ab", "aB", "a  b", "a--b", "a..b"];
    const badges = [...badgesOf(names.map((name) => view(name))).values()].map((b) => b.abbreviation);
    expect(badges).toEqual(["AB", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "AB", "AB"]);
  });
});

describe("the activity glyph", () => {
  const summary = (state: "idle" | "starting" | "running" | "parked", parkedPromptCount = 0) => ({
    activity: { state, since: "2026-09-24T00:00:00.000Z" },
    parkedPromptCount,
  });

  it("is a dot when idle, a ring while starting, a disc while running, and a question with its count when parked", () => {
    expect(glyphOf(summary("idle")).text).toBe("·");
    expect(glyphOf(summary("starting")).text).toBe("◌");
    expect(glyphOf(summary("running")).text).toBe("●");
    expect(glyphOf(summary("parked", 3)).text).toBe("?3");
  });

  it("counts a parked prompt on a session whose activity says otherwise, as the runtime's run states do", () => {
    expect(glyphOf(summary("running", 2)).text).toBe("?2");
    expect(glyphOf(summary("parked", 0)).text).toBe("?");
  });
});
