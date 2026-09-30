import { CATALOGUE } from "../src/index.js";

/**
 * Fixtures for the catalogue's schemas (skills spec, "The catalogue"): a
 * valid and an invalid instance of each schema the export writes, the
 * shipped catalogue among the valid ones. Each invalid one is refused by
 * the export too, so a rule only zod's refinements hold (a count equal to
 * the members, rising versions, unique ids) is the contract test's
 * (`src/catalogue.test.ts`), not these. `fixtures.ts` folds them into the
 * package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const [skillEntry] = CATALOGUE.skills;
const [seed] = CATALOGUE.instructions.entries;
const licence = { spdx: "MIT", where: { kind: "file", path: "LICENSE" }, holder: "Matt Pocock", link: "https://github.com/mattpocock/skills/blob/main/LICENSE", note: null };
const cautioned = { spdx: "MIT", where: { kind: "readme" }, holder: null, link: "https://github.com/theclaymethod/unslop/blob/main/README.md", note: "Declared in the README only." };
const member = { name: "tdd", description: "Test-driven development: red, green, refactor.", invocation: "model+slash" };
const entry = {
  id: "example-skills",
  url: "git@github.com:example/skills.git",
  folder: "skills",
  title: "Example",
  pitch: "An example entry.",
  licence,
  skillCount: 1,
  members: [member],
  alwaysOnHints: [{ name: "tdd", characters: 3359 }],
  fastMoving: false,
  tags: ["engineering"],
};
const instruction = { id: "coding.example", group: "coding", title: "Example", summary: "An example instruction.", version: 1, text: "Do the example.", earlierVersions: [] };
const risen = { ...instruction, version: 2, text: "Do the example again.", earlierVersions: [{ version: 1, text: "Do the example." }] };

export const catalogueSchemaFixtures: Record<string, Fixtures> = {
  "catalogue/skill-entry-id.json": {
    valid: ["unslop", "mattpocock-engineering", "a"],
    invalid: ["", "Unslop", "matt_pocock", "-unslop", "a".repeat(65), "coding.fresh-checkout"],
  },
  "catalogue/tag.json": {
    valid: ["writing", "code-review", "ci"],
    invalid: ["", "Writing", "code review", "tag-", 3],
  },
  "catalogue/licence-where.json": {
    valid: [{ kind: "file", path: "LICENSE" }, { kind: "file", path: "cursor-team-kit/LICENSE" }, { kind: "frontmatter" }, { kind: "readme" }, { kind: "none" }],
    invalid: ["LICENSE", "frontmatter", { kind: "file" }, { kind: "file", path: "../LICENSE" }, { kind: "file", path: "/LICENSE" }, { kind: "website" }],
  },
  "catalogue/licence.json": {
    valid: [licence, cautioned, { spdx: null, where: { kind: "none" }, holder: null, link: "https://github.com/example/skills", note: "Nothing declares a licence." }, { ...licence, spdx: "MIT OR Apache-2.0" }],
    invalid: [{ ...licence, spdx: "" }, { ...licence, spdx: "MIT licence" }, { ...licence, link: "http://github.com/mattpocock/skills" }, { ...licence, holder: "" }, { ...licence, note: "" }, { ...licence, where: undefined }],
  },
  "catalogue/skill-member.json": {
    valid: [member, { name: "to-spec", description: "Turn the conversation into a spec.", invocation: "slash-only" }],
    invalid: [{ ...member, name: "To Spec" }, { ...member, description: "" }, { ...member, invocation: "model" }, { name: "tdd" }],
  },
  "catalogue/always-on-hint.json": {
    valid: [{ name: "unslop", characters: 5924 }, { name: "a", characters: 1 }],
    invalid: [{ name: "unslop", characters: 0 }, { name: "unslop", characters: 1.5 }, { name: "Unslop", characters: 10 }, { name: "unslop" }],
  },
  "catalogue/skill-entry.json": {
    valid: [entry, { ...entry, folder: ".", alwaysOnHints: [], tags: [], licence: cautioned }, skillEntry],
    invalid: [
      { ...entry, url: "https://github.com/example/skills?tab=readme" },
      { ...entry, folder: "../skills" },
      { ...entry, skillCount: 0 },
      { ...entry, members: [], skillCount: 1 },
      { ...entry, tags: ["engineering", "engineering"] },
      { ...entry, fastMoving: "no" },
      { ...entry, licence: { ...licence, where: "LICENSE" } },
    ],
  },
  "catalogue/instruction-group-id.json": {
    valid: ["setup", "coding", "working", "custom"],
    invalid: ["", "working-with-me", "Setup"],
  },
  "catalogue/instruction-group.json": {
    valid: [{ id: "working", title: "Working with me" }, ...CATALOGUE.instructions.groups],
    invalid: [{ id: "working" }, { id: "writing", title: "Writing" }, { id: "coding", title: "" }],
  },
  "catalogue/instruction-entry-id.json": {
    valid: ["coding.fresh-checkout", "setup.about-my-setup", "working.ask-with-a-recommendation", "custom.a"],
    invalid: ["", "fresh-checkout", "writing.fresh-checkout", "coding.Fresh", "coding.", "coding.fresh.checkout"],
  },
  "catalogue/instruction-version-number.json": {
    valid: [1, 2, 40],
    invalid: [0, -1, 1.5, "1"],
  },
  "catalogue/instruction-version.json": {
    valid: [{ version: 1, text: "Do the example." }],
    invalid: [{ version: 0, text: "Do the example." }, { version: 1, text: "" }, { version: 1, text: "t".repeat(20_001) }, { text: "Do the example." }],
  },
  "catalogue/instruction-entry.json": {
    valid: [instruction, risen, seed],
    invalid: [
      { ...instruction, id: "example" },
      { ...instruction, group: "writing" },
      { ...instruction, title: "" },
      { ...instruction, title: "t".repeat(121) },
      { ...instruction, version: 0 },
      { ...instruction, text: "" },
      { ...instruction, earlierVersions: undefined },
      { ...instruction, summary: undefined },
    ],
  },
  "catalogue/catalogue.json": {
    valid: [CATALOGUE, { skills: [], instructions: { groups: CATALOGUE.instructions.groups, entries: [{ ...instruction, id: "setup.seed", group: "setup" }] } }],
    invalid: [{ skills: [] }, { ...CATALOGUE, skills: [{ ...entry, skillCount: 0 }] }, { ...CATALOGUE, instructions: { groups: [], entries: [{ ...instruction, version: "1" }] } }],
  },
};
