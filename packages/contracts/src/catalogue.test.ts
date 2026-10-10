import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CATALOGUE,
  CATALOGUE_SEED_INSTRUCTION_ID,
  Catalogue,
  CatalogueInstructionEntry,
  CatalogueSkillEntry,
  approximateTokens,
  catalogueTickStates,
  skillCollectionName,
  type Catalogue as CatalogueType,
  type CatalogueInstructionEntry as CatalogueInstructionEntryType,
  type CatalogueSkillEntry as CatalogueSkillEntryType,
  type SkillSource,
} from "./index.js";

/**
 * The catalogue's contract test (skills spec, "The catalogue"; ADR 0016,
 * ADR 0029, ADR 0030): the suggestions the Skills and Instructions steps
 * offer, as the contracts ship them, held to the schema, #492's URL and
 * folder rules, unique ids, counts equal to the members, hints among the
 * members and rising versions that keep every earlier text; and the tick
 * state, derived from the environment's sources.
 */

/** The messages a schema refuses `value` with, each at its path. */
const refusals = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

/** The params of the issues a schema refuses `value` with. */
const refusalParams = (schema: z.ZodType, value: unknown): unknown[] => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => ("params" in issue ? issue.params : undefined));
};

const entry = (id: string): CatalogueSkillEntryType => {
  const found = CATALOGUE.skills.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no skills entry ${id}`);
  return found;
};

const engineering = entry("mattpocock-engineering");
const unslop = entry("unslop");

const instruction = (id: string): CatalogueInstructionEntryType => {
  const found = CATALOGUE.instructions.entries.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no instruction entry ${id}`);
  return found;
};

const freshCheckout = instruction("coding.fresh-checkout");

/** The shipped catalogue with its skills entries replaced. */
const withSkills = (skills: CatalogueSkillEntryType[]): CatalogueType => ({ ...CATALOGUE, skills });

/** The shipped catalogue with its instruction entries replaced. */
const withInstructions = (entries: CatalogueInstructionEntryType[]): CatalogueType => ({ ...CATALOGUE, instructions: { ...CATALOGUE.instructions, entries } });

describe("the catalogue", () => {
  it("parses through its schema unchanged, so what ships is what a client validates, every folder already as the folder rule normalises it", () => {
    expect(Catalogue.parse(CATALOGUE)).toEqual(CATALOGUE);
  });

  it("is valid against its published schema, which a client in another language validates it with", () => {
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "catalogue", "catalogue.json"), "utf8")) as object);
    expect(validate(JSON.parse(JSON.stringify(CATALOGUE))), JSON.stringify(validate.errors)).toBe(true);
  });

  it("offers the 2026-09-22 research's skills entries: the Pocock set at its folders two levels down, unslop at its root, the Cursor team kit and Superpowers", () => {
    expect(CATALOGUE.skills.map(({ id, url, folder }) => [id, url, folder])).toEqual([
      ["mattpocock-engineering", "https://github.com/mattpocock/skills", "skills/engineering"],
      ["mattpocock-productivity", "https://github.com/mattpocock/skills", "skills/productivity"],
      ["unslop", "https://github.com/theclaymethod/unslop", "."],
      ["cursor-team-kit", "https://github.com/cursor/plugins", "cursor-team-kit/skills"],
      ["superpowers", "https://github.com/obra/superpowers", "skills"],
    ]);
  });

  it("lists each entry's members with their invocation, the count equal to them", () => {
    expect(CATALOGUE.skills.map(({ id, skillCount }) => [id, skillCount])).toEqual([
      ["mattpocock-engineering", 20],
      ["mattpocock-productivity", 7],
      ["unslop", 1],
      ["cursor-team-kit", 18],
      ["superpowers", 15],
    ]);
    expect(engineering.members).toContainEqual(expect.objectContaining({ name: "tdd", invocation: "model+slash" }));
    expect(engineering.members).toContainEqual(expect.objectContaining({ name: "setup-matt-pocock-skills", invocation: "slash-only" }));
    expect(unslop.members).toEqual([expect.objectContaining({ name: "unslop", invocation: "model+slash" })]);
  });

  it("suggests unslop always-on with its size, applying nothing, and no other member", () => {
    expect(CATALOGUE.skills.flatMap((skills) => skills.alwaysOnHints.map((hint) => [skills.id, hint.name]))).toEqual([["unslop", "unslop"]]);
    expect(approximateTokens(unslop.alwaysOnHints[0]?.characters ?? 0)).toBe(1481);
  });

  it("reads a licence file plainly and unslop's README and frontmatter grant with its caution", () => {
    expect(engineering.licence).toEqual({ spdx: "MIT", where: { kind: "file", path: "LICENSE" }, holder: "Matt Pocock", link: "https://github.com/mattpocock/skills/blob/main/LICENSE", note: null });
    expect(entry("cursor-team-kit").licence.where).toEqual({ kind: "file", path: "cursor-team-kit/LICENSE" });
    expect(unslop.licence).toMatchObject({ spdx: "MIT", where: { kind: "frontmatter" }, holder: null });
    expect(unslop.licence.note).toMatch(/no LICENSE file/);
  });

  it("groups its instructions under Setup, Coding, Working with me and Custom, the Setup group holding only the seed", () => {
    expect(CATALOGUE.instructions.groups).toEqual([
      { id: "setup", title: "Setup" },
      { id: "coding", title: "Coding" },
      { id: "working", title: "Working with me" },
      { id: "custom", title: "Custom" },
    ]);
    expect(CATALOGUE.instructions.entries.filter((entry) => entry.group === "setup").map((entry) => entry.title)).toEqual(["About my setup"]);
    expect(CATALOGUE.instructions.entries.map((entry) => entry.id)).toEqual([
      "setup.about-my-setup",
      "coding.fresh-checkout",
      "coding.pr-still-open",
      "coding.read-bot-reviews",
      "coding.no-attribution",
      "working.ask-with-a-recommendation",
    ]);
  });
});

describe("a skills entry", () => {
  it("holds #492's source URL rule, refusing a URL a source could not be added with", () => {
    expect(refusalParams(CatalogueSkillEntry, { ...engineering, url: "https://x-access-token:token-for-tests@github.com/mattpocock/skills" })).toEqual([{ rule: "source-url", reason: "credential" }]);
    expect(refusalParams(CatalogueSkillEntry, { ...engineering, url: "http://github.com/mattpocock/skills" })).toEqual([{ rule: "source-url", reason: "scheme" }]);
  });

  it("holds #492's folder rule, normalising a folder as a source's is, which a shipped entry would not parse unchanged through", () => {
    expect(refusalParams(CatalogueSkillEntry, { ...engineering, folder: "../skills" })).toEqual([{ rule: "source-folder", reason: "parent" }]);
    expect(refusalParams(CatalogueSkillEntry, { ...engineering, folder: "/skills" })).toEqual([{ rule: "source-folder", reason: "absolute" }]);
    expect(CatalogueSkillEntry.parse({ ...engineering, folder: ".\\skills\\engineering\\" }).folder).toBe("skills/engineering");
    expect(CatalogueSkillEntry.parse({ ...unslop, folder: "./" }).folder).toBe(".");
  });

  it("counts exactly the members it lists, each name once", () => {
    expect(refusals(CatalogueSkillEntry, { ...engineering, skillCount: 18 })).toEqual(["skillCount: The entry counts 18 skills and lists 20 members."]);
    const members = [...unslop.members, ...unslop.members];
    expect(refusals(CatalogueSkillEntry, { ...unslop, skillCount: 2, members })).toEqual(["members.1.name: The member unslop is listed twice."]);
  });

  it("hints only its own members always-on, each once", () => {
    expect(refusals(CatalogueSkillEntry, { ...engineering, alwaysOnHints: [{ name: "unslop", characters: 5924 }] })).toEqual(["alwaysOnHints.0.name: The always-on hint unslop is not one of the entry's members."]);
    const twice = [...unslop.alwaysOnHints, ...unslop.alwaysOnHints];
    expect(refusals(CatalogueSkillEntry, { ...unslop, alwaysOnHints: twice })).toEqual(["alwaysOnHints.1.name: The always-on hint unslop is given twice."]);
  });

  it("tells a licence file apart from frontmatter, readme and none, and cautions whenever there is no file or no holder", () => {
    for (const where of [{ kind: "frontmatter" }, { kind: "readme" }]) {
      expect(refusals(CatalogueSkillEntry, { ...unslop, licence: { ...unslop.licence, where } })).toEqual([]);
      expect(refusals(CatalogueSkillEntry, { ...unslop, licence: { ...unslop.licence, where, note: null } })).toEqual([
        "licence.note: A licence not declared in a file, or naming no holder, carries a note saying so.",
      ]);
    }
    expect(refusals(CatalogueSkillEntry, { ...engineering, licence: { ...engineering.licence, holder: null } })).toEqual([
      "licence.note: A licence not declared in a file, or naming no holder, carries a note saying so.",
    ]);
    const none = { spdx: null, where: { kind: "none" }, holder: null, link: "https://github.com/mattpocock/skills", note: "Nothing in the repository declares a licence." };
    expect(refusals(CatalogueSkillEntry, { ...engineering, licence: none })).toEqual([]);
    expect(refusals(CatalogueSkillEntry, { ...engineering, licence: { ...none, spdx: "MIT" } })).toEqual(["licence.spdx: A licence names its SPDX id exactly when something declares one."]);
    expect(refusals(CatalogueSkillEntry, { ...unslop, licence: { ...unslop.licence, spdx: null } })).toEqual(["licence.spdx: A licence names its SPDX id exactly when something declares one."]);
    expect(CatalogueSkillEntry.safeParse({ ...engineering, licence: { ...engineering.licence, where: { kind: "file", path: "../LICENSE" } } }).success).toBe(false);
    expect(CatalogueSkillEntry.safeParse({ ...engineering, licence: { ...engineering.licence, where: "LICENSE" } }).success).toBe(false);
  });
});

describe("an instruction entry", () => {
  const second = "Before you reference code, pull or clone the current default branch, and say which commit you read.";
  const third = "Read code from the current default branch, freshly pulled or cloned, and name the commit.";

  it("keeps every earlier version's text, oldest first, so a copy of any version diffs against the current one", () => {
    const risen = { ...freshCheckout, version: 3, text: third, earlierVersions: [{ version: 1, text: freshCheckout.text }, { version: 2, text: second }] };
    expect(CatalogueInstructionEntry.parse(risen)).toEqual(risen);
  });

  it("refuses a version whose earlier texts are missing, out of order or beyond it", () => {
    const refusedWith = (earlierVersions: { version: number; text: string }[], version = 3) => refusals(CatalogueInstructionEntry, { ...freshCheckout, version, text: third, earlierVersions });
    expect(refusedWith([])).toEqual(["earlierVersions: Version 3 keeps the text of every earlier version, oldest first: 1 to 2, not none."]);
    expect(refusedWith([{ version: 2, text: second }])).toEqual(["earlierVersions: Version 3 keeps the text of every earlier version, oldest first: 1 to 2, not 2."]);
    expect(refusedWith([{ version: 2, text: second }, { version: 1, text: freshCheckout.text }])).toEqual([
      "earlierVersions: Version 3 keeps the text of every earlier version, oldest first: 1 to 2, not 2, 1.",
    ]);
    expect(refusedWith([], 2)).toEqual(["earlierVersions: Version 2 keeps the text of every earlier version, oldest first: 1, not none."]);
    expect(refusedWith([{ version: 1, text: freshCheckout.text }], 1)).toEqual(["earlierVersions: Version 1 keeps the text of every earlier version, oldest first: none, not 1."]);
  });

  it("refuses a version far beyond its earlier texts without counting up to it", () => {
    expect(refusals(CatalogueInstructionEntry, { ...freshCheckout, version: 1_000_000_000 })).toEqual([
      "earlierVersions: Version 1000000000 keeps the text of every earlier version, oldest first: 1 to 999999999, not none.",
    ]);
  });

  it("rises only when its text changes", () => {
    expect(refusals(CatalogueInstructionEntry, { ...freshCheckout, version: 2, earlierVersions: [{ version: 1, text: freshCheckout.text }] })).toEqual(["text: Version 2 has the same text as version 1."]);
    expect(refusals(CatalogueInstructionEntry, { ...freshCheckout, version: 3, text: third, earlierVersions: [{ version: 1, text: second }, { version: 2, text: second }] })).toEqual([
      "earlierVersions.1.text: Version 2 has the same text as version 1.",
    ]);
  });

  it("is named within its group", () => {
    expect(refusals(CatalogueInstructionEntry, { ...freshCheckout, group: "working" })).toEqual(["id: coding.fresh-checkout is not an id of the working group."]);
    expect(CatalogueInstructionEntry.safeParse({ ...freshCheckout, id: "fresh-checkout" }).success).toBe(false);
  });

  it("fits an owned instruction's bounds, so a ticked copy always does", () => {
    expect(CatalogueInstructionEntry.safeParse({ ...freshCheckout, title: "t".repeat(121) }).success).toBe(false);
    expect(CatalogueInstructionEntry.safeParse({ ...freshCheckout, text: "t".repeat(20_001) }).success).toBe(false);
    expect(CatalogueInstructionEntry.safeParse({ ...freshCheckout, title: "t".repeat(120), text: "t".repeat(20_000) }).success).toBe(true);
  });
});

describe("the catalogue's ids and places", () => {
  it("refuses a skills entry id used twice", () => {
    expect(refusals(Catalogue, withSkills([...CATALOGUE.skills, { ...unslop, folder: "references" }]))).toEqual(["skills.5.id: The skills entry id unslop is used twice."]);
  });

  it("refuses two skills entries at one repository identity and folder, however the URL is spelled", () => {
    const again = { ...engineering, id: "pocock-by-ssh", url: "git@github.com:MattPocock/skills.git" };
    expect(refusals(Catalogue, withSkills([...CATALOGUE.skills, again]))).toEqual(["skills.5.folder: Another skills entry already offers https://github.com/mattpocock/skills skills/engineering."]);
  });

  it("refuses an instruction id used twice", () => {
    const entries = [...CATALOGUE.instructions.entries, { ...freshCheckout, title: "Another" }];
    expect(refusals(Catalogue, withInstructions(entries))).toEqual(["instructions.entries.6.id: The instruction id coding.fresh-checkout is used twice."]);
  });

  it("refuses a second Setup entry, a Setup group without its seed, and any Custom entry", () => {
    const seed = instruction("setup.about-my-setup");
    const others = CATALOGUE.instructions.entries.filter((entry) => entry !== seed);
    expect(refusals(Catalogue, withInstructions([...CATALOGUE.instructions.entries, { ...seed, id: "setup.more" }]))).toEqual([
      "instructions.entries: The Setup group holds only the seed, setup.about-my-setup: it holds setup.about-my-setup, setup.more.",
    ]);
    expect(refusals(Catalogue, withInstructions(others))).toEqual(["instructions.entries: The Setup group holds only the seed, setup.about-my-setup: it holds none."]);
    expect(refusals(Catalogue, withInstructions([{ ...seed, id: "setup.something-else" }, ...others]))).toEqual([
      "instructions.entries: The Setup group holds only the seed, setup.about-my-setup: it holds setup.something-else.",
    ]);
    expect(CATALOGUE_SEED_INSTRUCTION_ID).toBe(seed.id);
    expect(refusals(Catalogue, withInstructions([...CATALOGUE.instructions.entries, { ...freshCheckout, id: "custom.mine", group: "custom" }]))).toEqual([
      "instructions.entries: The Custom group holds a person's own instructions, never a catalogue entry.",
    ]);
  });

  it("refuses the groups in another order or with one missing", () => {
    const [setup, coding, working, custom] = CATALOGUE.instructions.groups;
    for (const groups of [[setup, working, coding, custom], [setup, coding, working]]) {
      expect(refusals(Catalogue, { ...CATALOGUE, instructions: { ...CATALOGUE.instructions, groups } })).toEqual(["instructions.groups: The groups are setup, coding, working, custom, in that order."]);
    }
  });
});

describe("the tick state", () => {
  /** A source as `skills.get` answers it. */
  const source = (id: string, url: string, identity: string, folder: string, position: number): SkillSource => ({
    id,
    url,
    identity,
    folder,
    follow: { kind: "branch", branch: null },
    position,
    addedBy: { kind: "client_session", id: "cs-1" },
    addedAt: "2026-09-30T02:00:00.000Z",
  });
  const pocockEngineering = source("0f8fad5b-d9cb-469f-a165-70867728950e", "git@github.com:mattpocock/skills.git", "https://github.com/mattpocock/skills", "skills/engineering", 1);
  const unslopRoot = source("7c9e6679-7425-40de-944b-e07fc1f90ae7", "https://github.com/theclaymethod/unslop.git", "https://github.com/theclaymethod/unslop", ".", 2);
  const pocockSkills = source("1b4e28ba-2fa1-41d2-883f-0016d3cca427", "https://github.com/mattpocock/skills", "https://github.com/mattpocock/skills", "skills", 3);
  const elsewhere = source("6fa459ea-ee8a-4ca4-894e-db77e160355e", "https://git.systemtech.dev:5526/david/agent-skills", "https://git.systemtech.dev/david/agent-skills", "skills", 4);

  it("answers every entry untracked when the environment tracks nothing", () => {
    expect(catalogueTickStates(CATALOGUE.skills, [])).toEqual(CATALOGUE.skills.map((skills) => ({ entryId: skills.id, state: "untracked" })));
  });

  it("ticks an entry whose identity and folder a source has, naming the source, however the source's URL was spelled", () => {
    expect(catalogueTickStates(CATALOGUE.skills, [pocockEngineering, unslopRoot, elsewhere])).toEqual([
      { entryId: "mattpocock-engineering", state: "tracked", sourceId: pocockEngineering.id },
      { entryId: "mattpocock-productivity", state: "untracked" },
      { entryId: "unslop", state: "tracked", sourceId: unslopRoot.id },
      { entryId: "cursor-team-kit", state: "untracked" },
      { entryId: "superpowers", state: "untracked" },
    ]);
  });

  it("leaves an entry unticked when a source has its repository at another folder", () => {
    expect(catalogueTickStates(CATALOGUE.skills, [pocockSkills]).map((tick) => tick.state)).toEqual(["untracked", "untracked", "untracked", "untracked", "untracked"]);
  });

  it("names a source by the title of the entry it tracks, else by its repository's path and the folder it reads below the root", () => {
    expect(skillCollectionName(pocockEngineering, CATALOGUE.skills)).toBe("Matt Pocock — engineering");
    expect(skillCollectionName(unslopRoot, CATALOGUE.skills)).toBe("Unslop");
    expect(skillCollectionName(pocockSkills, CATALOGUE.skills)).toBe("mattpocock/skills (skills)");
    expect(skillCollectionName({ identity: "https://git.example.test/team/procedures", folder: "." }, CATALOGUE.skills)).toBe("team/procedures");
  });

  it("names the first source given when two have the entry's identity and folder", () => {
    const later = { ...pocockEngineering, id: "6fa459ea-ee8a-4ca4-894e-db77e160355e", position: 5 };
    expect(catalogueTickStates([engineering], [pocockEngineering, later])).toEqual([{ entryId: "mattpocock-engineering", state: "tracked", sourceId: pocockEngineering.id }]);
  });
});
