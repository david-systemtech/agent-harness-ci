import type { EnvironmentView } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { abbreviationOf, badgesOf, glyphOf } from "./badge.js";

/**
 * The environment badge on every rail row (ADR 0005; docs/specs/tui.md, "The
 * rail"): the environment's colour, mapped onto one of the terminal's, and a
 * two-letter abbreviation of its name unique among the environments listed;
 * and the activity glyph.
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
  it("give each environment a colour and an abbreviation no other has, and no icon: the terminal UI draws none (#19)", () => {
    const badges = badgesOf([view("desk"), view("dev box"), view("laptop"), view("develop")]);
    expect([...badges.values()].map((b) => b.abbreviation)).toEqual(["DE", "DB", "LA", "DV"]);
    expect(new Set([...badges.values()].map((b) => b.colour)).size).toBe(4);
    expect(badges.get("id-desk")).toEqual({ abbreviation: "DE", colour: "cyan" });
  });

  it("take the environment's own colour, the twelve names in order onto red, bright red, yellow, bright yellow, bright green, green, cyan, bright cyan, blue, bright blue, magenta and bright magenta", () => {
    const names = ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"] as const;
    const badges = badgesOf(names.map((colour) => view(`${colour} box`, { colour })));
    expect(names.map((colour) => badges.get(`id-${colour} box`)?.colour)).toEqual([
      "red",
      "redBright",
      "yellow",
      "yellowBright",
      "greenBright",
      "green",
      "cyan",
      "cyanBright",
      "blue",
      "blueBright",
      "magenta",
      "magentaBright",
    ]);
  });

  it("keep a colour by the environment's place in the list for one that sends no colour, whatever its neighbours send", () => {
    const badges = badgesOf([view("desk", { colour: "amber", icon: "laptop" }), view("tower"), view("nas", { icon: "nas" })]);
    expect(badges.get("id-desk")).toEqual({ abbreviation: "DE", colour: "yellow" });
    expect(badges.get("id-tower")).toEqual({ abbreviation: "TO", colour: "magenta" });
    expect(badges.get("id-nas")).toEqual({ abbreviation: "NA", colour: "yellow" });
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
