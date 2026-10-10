import { z } from "zod";
import { MAX_INSTRUCTION_BODY, MAX_INSTRUCTION_TITLE } from "./instructions.js";
import { setOf } from "./primitives.js";
import { repositoryIdentityOf } from "./repository-identity.js";
import { SkillInvocation, SkillName, SkillSourceFolder, SkillSourceUrl } from "./skill-rules.js";
import type { SkillSource, SkillSourceId } from "./skills.js";

/**
 * The catalogue (skills spec, "The catalogue"; ADR 0016, ADR 0029, ADR
 * 0030): the suggestions the Skills and Instructions steps offer, shipped
 * in this package, versioned with the build and published as JSON Schema.
 * Skills entries are repository folders a person may track as skill
 * sources; instruction entries are texts a person may tick to own a copy
 * of. Nothing in it is ticked or always-on until a person acts: whether an
 * entry is tracked is derived from the environment's sources, never
 * stored (`catalogueTickStates`). The entries themselves are
 * `catalogue-data.ts`.
 *
 * The schemas hold the rules a contract test holds the shipped catalogue
 * to: zod's refinements check what the export cannot state (a count equal
 * to its members, rising versions, unique ids), and each rule is named in
 * the description a client in another language reads.
 */

/** Adds a custom issue at `path` to `ctx`. */
const refuse = (ctx: z.RefinementCtx, path: readonly PropertyKey[], message: string): void => {
  ctx.addIssue({ code: "custom", path: [...path], message });
};

/** The indices of `values` that repeat an earlier one. */
const repeats = <T>(values: readonly T[]): number[] => values.flatMap((value, index) => (values.indexOf(value) < index ? [index] : []));

// Ids and tags ----------------------------------------------------------------------------

/** One lower-case word or run of words joined by single hyphens. */
const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)*";

/** A skills entry's id. */
export const CatalogueSkillEntryId = z
  .string()
  .max(64)
  .regex(new RegExp(`^${KEBAB}$`))
  .meta({ description: "A skills entry's id: 1 to 64 of a-z, 0-9 and single hyphens, such as mattpocock-engineering. Stable across builds." });
export type CatalogueSkillEntryId = z.infer<typeof CatalogueSkillEntryId>;

/** A word an entry is filed under. */
export const CatalogueTag = z
  .string()
  .max(40)
  .regex(new RegExp(`^${KEBAB}$`))
  .meta({ description: "A word a skills entry is filed under, such as engineering or writing: a-z, 0-9 and single hyphens." });
export type CatalogueTag = z.infer<typeof CatalogueTag>;

// Skills entries --------------------------------------------------------------------------

/** An https link. */
const HttpsLink = z.url({ protocol: /^https$/ }).meta({ pattern: "^https://" });

/**
 * Where a licence was declared (ADR 0029: the licence line reads by it):
 * a licence file, by its path from the repository's root; or, with no
 * file, a skill's frontmatter, the README, or nowhere. The card reads a
 * file plainly and anything else with a caution.
 */
export const CatalogueLicenceWhere = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("file"),
        path: SkillSourceFolder.meta({ description: "The licence file's path from the repository's root, such as LICENSE, or cursor-team-kit/LICENSE where each folder has its own." }),
      })
      .meta({ description: "A licence file states it." }),
    z.object({ kind: z.literal("frontmatter") }).meta({ description: "Only a license key in the skills' SKILL.md frontmatter states it: no licence file." }),
    z.object({ kind: z.literal("readme") }).meta({ description: "Only the README states it: no licence file." }),
    z.object({ kind: z.literal("none") }).meta({ description: "Nothing states a licence." }),
  ])
  .meta({
    description:
      "Where a skills entry's licence was declared: file (a licence file, by its path from the repository's root), frontmatter (a license key in SKILL.md, no file), readme (the README, no file) or none. A client shows a file plainly and anything else with a caution and the note.",
  });
export type CatalogueLicenceWhere = z.infer<typeof CatalogueLicenceWhere>;

/**
 * A skills entry's licence (ADR 0029; the 2026-09-22 research: a licence
 * belongs to a folder, not a repository, and "MIT in a README" is not the
 * promise "MIT in a LICENSE file" is): its SPDX id, where it was declared,
 * who holds the copyright, a link to read it, and a note where it needs a
 * caution. Written by the person adding the entry, never read off a
 * forge's licence API.
 */
export const CatalogueLicence = z
  .object({
    spdx: z
      .string()
      .regex(/^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/)
      .nullable()
      .meta({ description: "The licence as an SPDX identifier or expression, such as MIT or Apache-2.0; null exactly when nothing declares one." }),
    where: CatalogueLicenceWhere,
    holder: z.string().min(1).nullable().meta({ description: "The copyright holder the declaration names; null when it names none." }),
    link: HttpsLink.meta({ description: "An https link to read the declaration: the licence file, the SKILL.md or the README; the repository when nothing declares one." }),
    note: z.string().min(1).nullable().meta({
      description: "What a person should know before relying on the licence, shown beside it: present whenever it is not declared in a file or names no holder; null when a file states it with its holder.",
    }),
  })
  .meta({
    description:
      "A skills entry's licence: the SPDX id (null when nothing declares one), where it was declared, the copyright holder or null, an https link to the declaration, and a note, present whenever the licence is not in a file or names no holder.",
  });
export type CatalogueLicence = z.infer<typeof CatalogueLicence>;

/** A member of a skills entry's folder, as its card lists it. */
export const CatalogueSkillMember = z
  .object({
    name: SkillName.meta({ description: "The member's name by the member-naming rule, as the environment's reader names it." }),
    description: z.string().min(1).meta({ description: "What the member does, in a sentence written for the card." }),
    invocation: SkillInvocation,
  })
  .meta({ description: "A member of a skills entry's folder as its card lists it: its name, a sentence on what it does, and its invocation." });
export type CatalogueSkillMember = z.infer<typeof CatalogueSkillMember>;

/**
 * A member suggested as always-on (ADR 0029: a suggestion line, never
 * applied on tick), with the approximate characters its body adds to every
 * run.
 */
export const CatalogueAlwaysOnHint = z
  .object({
    name: SkillName.meta({ description: "The member suggested always-on: one of the entry's members." }),
    characters: z.int().positive().meta({ description: "About how many characters its body adds to every run, as the reader measured it; a quarter of it is the approximate tokens." }),
  })
  .meta({ description: "A member a skills entry suggests making always-on, never applied on tick, with about how many characters its body adds to every run." });
export type CatalogueAlwaysOnHint = z.infer<typeof CatalogueAlwaysOnHint>;

/**
 * A skills entry (skills spec, "The catalogue"; ADR 0029): a repository's
 * folder a person may tick to track as a skill source, with the title and
 * pitch its card shows, its licence, its members and their count, the
 * members suggested always-on, whether the repository changes often, and
 * tags. The URL and folder pass #492's rules; the shipped entries write
 * the folder as the rule normalises it, since the tick state compares it
 * with a source's as it is.
 */
export const CatalogueSkillEntry = z
  .object({
    id: CatalogueSkillEntryId,
    url: SkillSourceUrl.meta({ description: "The repository's URL, as a source tracking the entry is added with: it passes the source URL rule." }),
    folder: SkillSourceFolder.meta({ description: "The folder a source tracking the entry reads, normalised: . when the repository's root is itself one skill." }),
    title: z.string().min(1).meta({ description: "The card's title, which tells apart two entries of one repository." }),
    pitch: z.string().min(1).meta({ description: "One or two sentences on what the skills are for." }),
    licence: CatalogueLicence,
    skillCount: z.int().positive().meta({ description: "How many members the folder yields by the root-skill rule: the number of members listed." }),
    members: z.array(CatalogueSkillMember).min(1).meta({ description: "Every member the folder yields, by name, each name once." }),
    alwaysOnHints: z.array(CatalogueAlwaysOnHint).meta({ description: "The members suggested always-on, each one of the members and named once; empty for none." }),
    fastMoving: z.boolean().meta({ description: "Whether the repository changes often, so a person tracking it sees its skills change: a card says so." }),
    tags: setOf(CatalogueTag).meta({ description: "The words the entry is filed under, each once." }),
  })
  .superRefine((entry, ctx) => {
    if (entry.skillCount !== entry.members.length) refuse(ctx, ["skillCount"], `The entry counts ${entry.skillCount} skills and lists ${entry.members.length} members.`);
    const names = entry.members.map((member) => member.name);
    for (const index of repeats(names)) refuse(ctx, ["members", index, "name"], `The member ${names[index] ?? ""} is listed twice.`);
    const hinted = entry.alwaysOnHints.map((hint) => hint.name);
    for (const index of repeats(hinted)) refuse(ctx, ["alwaysOnHints", index, "name"], `The always-on hint ${hinted[index] ?? ""} is given twice.`);
    hinted.forEach((name, index) => {
      if (!names.includes(name)) refuse(ctx, ["alwaysOnHints", index, "name"], `The always-on hint ${name} is not one of the entry's members.`);
    });
    const { where, spdx, holder, note } = entry.licence;
    if ((spdx === null) !== (where.kind === "none")) refuse(ctx, ["licence", "spdx"], "A licence names its SPDX id exactly when something declares one.");
    if ((where.kind !== "file" || holder === null) && note === null) refuse(ctx, ["licence", "note"], "A licence not declared in a file, or naming no holder, carries a note saying so.");
  })
  .meta({
    description:
      "A skills entry: a repository's folder a person may tick to track as a skill source. Its id, URL and folder (passing the source URL and folder rules, the folder normalised), title, pitch, licence, skill count (equal to the members listed), members (each name once), always-on hints (each one of the members, named once), whether the repository changes often, and tags. A licence's spdx is null exactly when where is none, and it has a note whenever where is not a file or holder is null.",
  });
export type CatalogueSkillEntry = z.infer<typeof CatalogueSkillEntry>;

// Instruction entries ---------------------------------------------------------------------

/**
 * The instruction groups, in the order the Instructions step shows them
 * (ADR 0030): Setup, which holds only the seeded "About my setup"; Coding;
 * Working with me; and Custom, where a person writes their own, which the
 * catalogue leaves empty.
 */
export const CATALOGUE_INSTRUCTION_GROUPS = ["setup", "coding", "working", "custom"] as const;
export const CatalogueInstructionGroupId = z.enum(CATALOGUE_INSTRUCTION_GROUPS).meta({
  description:
    "An instruction group: setup (only the seeded About my setup), coding (habits for work in a repository), working (Working with me: how the agent talks to you and delegates) or custom (a person's own, which the catalogue leaves empty).",
});
export type CatalogueInstructionGroupId = z.infer<typeof CatalogueInstructionGroupId>;

/** An instruction group as the step heads it. */
export const CatalogueInstructionGroup = z
  .object({
    id: CatalogueInstructionGroupId,
    title: z.string().min(1).meta({ description: "The group's heading: Setup, Coding, Working with me or Custom." }),
  })
  .meta({ description: "An instruction group: its id and the heading the Instructions step shows it under." });
export type CatalogueInstructionGroup = z.infer<typeof CatalogueInstructionGroup>;

/**
 * The seed's id: "About my setup", the Setup group's one entry, which the
 * Instructions step creates an owned copy of the first time it opens (ADR
 * 0030).
 */
export const CATALOGUE_SEED_INSTRUCTION_ID = "setup.about-my-setup";

/** An instruction entry's id: its group, a dot, and a name. */
export const CatalogueInstructionEntryId = z
  .string()
  .max(100)
  .regex(new RegExp(`^(?:${CATALOGUE_INSTRUCTION_GROUPS.join("|")})\\.${KEBAB}$`))
  .meta({
    description:
      "An instruction entry's id: its group, a dot, then a-z, 0-9 and single hyphens, such as coding.fresh-checkout. Stable across builds and versions: an owned copy's origin names it.",
  });
export type CatalogueInstructionEntryId = z.infer<typeof CatalogueInstructionEntryId>;

/** An instruction entry's version: 1, then one more each time its text changes. */
export const CatalogueInstructionVersionNumber = z.int().positive().meta({
  description: "An instruction entry's version: 1 for its first text, then one more each time the text changes.",
});

/** An instruction's text, bounded as an owned instruction's body is, so a ticked copy always fits. */
const InstructionText = z.string().min(1).max(MAX_INSTRUCTION_BODY);

/** An earlier version of an instruction entry: its number and its text then. */
export const CatalogueInstructionVersion = z
  .object({
    version: CatalogueInstructionVersionNumber,
    text: InstructionText.meta({ description: "The entry's text at that version, kept so a copy made from it diffs against the current text." }),
  })
  .meta({ description: "An earlier version of an instruction entry: its number and its text then." });
export type CatalogueInstructionVersion = z.infer<typeof CatalogueInstructionVersion>;

/**
 * An instruction entry (skills spec, "The catalogue"; ADR 0030): a text a
 * person ticks to own a copy of, which remembers the entry's id and
 * version. Every earlier version's text is kept, oldest first, so a copy of
 * any version diffs against the current one with both sides at hand.
 */
export const CatalogueInstructionEntry = z
  .object({
    id: CatalogueInstructionEntryId,
    group: CatalogueInstructionGroupId,
    title: z.string().min(1).max(MAX_INSTRUCTION_TITLE).meta({ description: "The instruction's title, which a copy takes: at most as long as an owned instruction's." }),
    summary: z.string().min(1).meta({ description: "One line on what the instruction asks, shown before its text." }),
    version: CatalogueInstructionVersionNumber,
    text: InstructionText.meta({ description: "The current version's text, in Markdown, which a copy takes: at most as long as an owned instruction's body." }),
    earlierVersions: z.array(CatalogueInstructionVersion).meta({
      description: "Every earlier version with its text, oldest first: versions 1 up to the current one's predecessor, each text unlike the next one's. Empty at version 1.",
    }),
  })
  .superRefine((entry, ctx) => {
    if (!entry.id.startsWith(`${entry.group}.`)) refuse(ctx, ["id"], `${entry.id} is not an id of the ${entry.group} group.`);
    const kept = entry.earlierVersions.length === entry.version - 1 && entry.earlierVersions.every((earlier, index) => earlier.version === index + 1);
    if (!kept) {
      const expected = entry.version === 1 ? "none" : entry.version === 2 ? "1" : `1 to ${entry.version - 1}`;
      const given = entry.earlierVersions.map((earlier) => earlier.version).join(", ") || "none";
      refuse(ctx, ["earlierVersions"], `Version ${entry.version} keeps the text of every earlier version, oldest first: ${expected}, not ${given}.`);
    }
    const texts = [...entry.earlierVersions.map((earlier) => earlier.text), entry.text];
    texts.slice(1).forEach((text, index) => {
      if (text === texts[index]) refuse(ctx, index + 1 === entry.earlierVersions.length ? ["text"] : ["earlierVersions", index + 1, "text"], `Version ${index + 2} has the same text as version ${index + 1}.`);
    });
  })
  .meta({
    description:
      "An instruction entry: its id (its group, a dot and a name), group, title, one-line summary, version, current text, and every earlier version's text, oldest first (versions 1 up to the current one's predecessor, each text unlike the next one's), so an owned copy of any version diffs against the current text.",
  });
export type CatalogueInstructionEntry = z.infer<typeof CatalogueInstructionEntry>;

// The catalogue -----------------------------------------------------------------------------

/**
 * The whole catalogue: the skills entries, and the instruction groups with
 * their entries. Beyond each entry's own rules: ids are unique within each
 * list, no two skills entries share a repository identity and folder (a
 * source would tick both), the groups are the four in their order, the
 * Setup group holds exactly one entry, the seed (by its id), and Custom
 * holds none.
 */
export const Catalogue = z
  .object({
    skills: z.array(CatalogueSkillEntry).meta({ description: "The skills entries, in the order the Skills step shows them." }),
    instructions: z
      .object({
        groups: z.array(CatalogueInstructionGroup).meta({ description: "The four groups in their order: setup, coding, working, custom." }),
        entries: z.array(CatalogueInstructionEntry).meta({ description: "The instruction entries, grouped by their group, in the order the step lists them." }),
      })
      .meta({ description: "The suggested instructions: the groups and their entries." }),
  })
  .superRefine((catalogue, ctx) => {
    const skillIds = catalogue.skills.map((entry) => entry.id);
    for (const index of repeats(skillIds)) refuse(ctx, ["skills", index, "id"], `The skills entry id ${skillIds[index] ?? ""} is used twice.`);
    const places = catalogue.skills.map((entry) => `${repositoryIdentityOf(entry.url, []) ?? entry.url} ${entry.folder}`);
    for (const index of repeats(places)) refuse(ctx, ["skills", index, "folder"], `Another skills entry already offers ${places[index] ?? ""}.`);
    const { groups, entries } = catalogue.instructions;
    if (groups.map((group) => group.id).join() !== CATALOGUE_INSTRUCTION_GROUPS.join()) refuse(ctx, ["instructions", "groups"], `The groups are ${CATALOGUE_INSTRUCTION_GROUPS.join(", ")}, in that order.`);
    const instructionIds = entries.map((entry) => entry.id);
    for (const index of repeats(instructionIds)) refuse(ctx, ["instructions", "entries", index, "id"], `The instruction id ${instructionIds[index] ?? ""} is used twice.`);
    const inGroup = (group: CatalogueInstructionGroupId): string[] => entries.filter((entry) => entry.group === group).map((entry) => entry.id);
    const setup = inGroup("setup");
    if (setup.join() !== CATALOGUE_SEED_INSTRUCTION_ID) {
      refuse(ctx, ["instructions", "entries"], `The Setup group holds only the seed, ${CATALOGUE_SEED_INSTRUCTION_ID}: it holds ${setup.join(", ") || "none"}.`);
    }
    if (inGroup("custom").length !== 0) refuse(ctx, ["instructions", "entries"], "The Custom group holds a person's own instructions, never a catalogue entry.");
  })
  .meta({
    description:
      "The catalogue the Skills and Instructions steps suggest from, shipped with the harness and versioned with the build: skills entries, and instruction groups with their entries. Ids are unique within each list; no two skills entries share a repository identity and folder; the groups are setup, coding, working and custom in that order; setup holds exactly one entry, the seed setup.about-my-setup (About my setup), and custom none.",
  });
export type Catalogue = z.infer<typeof Catalogue>;

// Tick state ------------------------------------------------------------------------------

/** Whether a skills entry shows ticked: tracked by a source, named by its id, or not. */
export type CatalogueTickState =
  | { readonly entryId: CatalogueSkillEntryId; readonly state: "tracked"; readonly sourceId: SkillSourceId }
  | { readonly entryId: CatalogueSkillEntryId; readonly state: "untracked" };

/**
 * The tick state of each skills entry, in the entries' order (skills spec,
 * "The catalogue"; ADR 0029), derived from the environment's sources as
 * `skills.get` answers them, never stored: an entry is tracked, naming the
 * source, when a source has the entry's repository identity and folder;
 * else untracked. The entry's identity is its URL's by the repository
 * identity rule (#324) with no forge accounts: a catalogue URL names a
 * forge's own host, which no verified alias rewrites. Of two sources
 * matching, the first given wins (`skills.get` lists the earliest added
 * first; the add refuses a second source of one identity and folder).
 * Unticking is the client's: `skills.sources.remove` on the source, after
 * one confirm.
 */
export const catalogueTickStates = (entries: readonly CatalogueSkillEntry[], sources: readonly SkillSource[]): CatalogueTickState[] =>
  entries.map((entry) => {
    const source = sources.find((candidate) => tracks(candidate, entry));
    return source === undefined ? { entryId: entry.id, state: "untracked" } : { entryId: entry.id, state: "tracked", sourceId: source.id };
  });

/** Whether `source` tracks `entry`: it has the entry's repository identity and folder. */
const tracks = (source: Pick<SkillSource, "identity" | "folder">, entry: CatalogueSkillEntry): boolean =>
  source.identity === repositoryIdentityOf(entry.url, []) && source.folder === entry.folder;

/**
 * A source as a person reads it, a skill collection (setup-copy.md §5.9's
 * `{collection}`; #1855): the title of the entry of `entries` it tracks, else
 * its repository's path on its host, with the folder it reads after it when
 * that is not the root.
 */
export const skillCollectionName = (source: Pick<SkillSource, "identity" | "folder">, entries: readonly CatalogueSkillEntry[]): string => {
  const entry = entries.find((candidate) => tracks(source, candidate));
  if (entry !== undefined) return entry.title;
  const repository = source.identity.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "");
  return source.folder === "." ? repository : `${repository} (${source.folder})`;
};
