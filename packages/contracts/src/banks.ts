import { z } from "zod";
import { RepositoryIdentity } from "./repository-identity.js";
import { SecretRule } from "./shape-rules.js";

/**
 * The memory bank structure contract (banks spec, "BANK.md and the folders"
 * and "The validator"; ADR 0010, ADR 0013, ADR 0034, ADR 0035, ADR 0037):
 * what a bank's `BANK.md`, its folder files and its memories hold, the caps
 * the validator enforces when something is written, and the validator's
 * rules by id. The validator itself is this package's `./bank-validator`
 * entry, kept out of the index so no client bundles the YAML library; it
 * builds to the one Node file each bank's CI runs, stamped with
 * `BANK_VALIDATOR`, which the describe prompt carries too.
 */

/** A bank's kind, from its `BANK.md`: one person's own, or a team's, which names its owners (ADR 0035, ADR 0037). */
export const BANK_KINDS = ["personal", "team"] as const;
export type BankKind = (typeof BANK_KINDS)[number];

/**
 * The orientation caps (ADR 0013), which the validator enforces when a
 * bank's orientation is written: at most five memory names, each memory's
 * body at most 600 bytes of UTF-8, and 1,500 bytes in all.
 */
export const ORIENTATION_CAPS = { names: 5, bytesEach: 600, bytesInAll: 1_500 } as const;

/**
 * The bank validator (ADR 0013: one validator, at draft, promote, the
 * bank's CI and the BankService), by name and the version of its rules: the
 * version of this structure contract. A prompt is written for one version:
 * the describe prompt carries it, the built `validate.mjs` is stamped with
 * it, and the version moves with the rules.
 */
export const BANK_VALIDATOR = { name: "bank-validator", version: 1 } as const;

/**
 * The other caps of the contract (banks spec; ADR 0013): a bank's name and
 * purpose, a folder's `line:` and a topic's one-liner, a memory's name,
 * description and body in characters, and the index tiers:
 * a folder's or topic's index (T3) and the root breadcrumbs (T2), each at
 * most 40 lines.
 */
export const BANK_CAPS = {
  bankName: 40,
  purpose: 160,
  line: 100,
  memoryName: 60,
  description: { min: 60, max: 160 },
  body: 6_000,
  indexLines: 40,
  rootLines: 40,
} as const;

/**
 * The one folder structure every bank has (ADR 0037), as `BANK.md` spells
 * it: the memory files' glob, the scope template (the labels `org`,
 * `project` and the optional `area`) and the path a memory is written to,
 * a declared topic one folder deeper. `schema` names the memory schema.
 */
export const BANK_LAYOUT = {
  glob: "projects/**/memories/**/*.md",
  scope: "projects/{org}/{project}[/{area}]/",
  schema: "memory",
  place: "projects/{org}/{project}[/{area}]/memories/[{topic}/]{name}.md",
} as const;

/** The labels a scope or write template may use (ADR 0037): the three scope levels, a topic and a memory's name. */
export const SCOPE_LABELS = ["org", "project", "area", "topic", "name"] as const;

/** The folder files, one per level: an org's, a project's and an area's (ADR 0037). */
export const SCOPE_FILES = { org: "ORG.md", project: "PROJECT.md", area: "AREA.md" } as const;

/** Keys the new ones replace (ADR 0034, ADR 0035), refused once the migration has run: in `BANK.md`, and in a folder file. */
export const RETIRED_KEYS = { manifest: ["description", "index"], folder: ["summary", "code"] } as const;

/** The changes a bank's merge rule always holds for review (ADR 0035, ADR 0037). */
export const REVIEWED_CLASSES = ["orientation", "decisions", "status", "manifest"] as const;

/** A memory's type, `metadata.type` in its frontmatter. */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

/** The words a description opens with so a run matches it to a task; one opening otherwise is warned. */
export const TRIGGER_WORDS = ["Before", "When", "After", "While", "If", "Where", "How", "What", "Which", "Why"] as const;

/** A lower-case slug: letters, digits and single hyphens between them. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The number of bytes `text` takes in UTF-8 (a lone surrogate as the replacement character's three). */
export const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
};

const oneLine = (cap: number, what: string) => {
  const error = `${what} is one line of 1 to ${cap} characters.`;
  return z.string({ error }).min(1, { error }).max(cap, { error }).regex(/^[^\r\n]*$/, { error });
};

/** A bank's name: a lower-case slug of 1 to 40 characters, unique per environment. */
export const BankName = z
  .string({ error: "name is a lower-case slug of 1 to 40 characters." })
  .max(BANK_CAPS.bankName, { error: "name is a lower-case slug of 1 to 40 characters." })
  .regex(SLUG, { error: "name is a lower-case slug of 1 to 40 characters." })
  .meta({ description: "A bank's name: 1 to 40 characters of lower-case letters, digits and single hyphens between them, unique per environment." });
export type BankName = z.infer<typeof BankName>;

/** A memory's name: a lower-case slug of at most 60 characters, its file's name, unique in its bank. */
const MemoryName = z
  .string({ error: "name is a lower-case slug of at most 60 characters." })
  .max(BANK_CAPS.memoryName, { error: "name is a lower-case slug of at most 60 characters." })
  .regex(SLUG, { error: "name is a lower-case slug of at most 60 characters." })
  .meta({ description: "A memory's name: a lower-case slug of at most 60 characters, its file's name (<name>.md) and unique in its bank; [[name]] links it." });
export type MemoryName = z.infer<typeof MemoryName>;

/** A topic's name: a lower-case slug, the folder its memories nest in. */
const TopicName = z.string().regex(SLUG).meta({ description: "A topic's name: a lower-case slug, the folder under memories/ its memories nest in." });

/**
 * A scope folder as a pointer names it (ADR 0013, ADR 0037): `org/`,
 * `org/project/` or `org/project/area/`, relative to `projects/`.
 */
export const SCOPE_FOLDER = /^[^/\s:]+\/(?:[^/\s:]+\/){0,2}$/;

const ScopeFolder = z
  .string({ error: "folder names a scope folder: org/, org/project/ or org/project/area/." })
  .regex(SCOPE_FOLDER, { error: "folder names a scope folder: org/, org/project/ or org/project/area/." })
  .meta({ description: "A scope folder as a pointer names it, relative to projects/: org/, org/project/ or org/project/area/, ending in a slash." });

/** An entity a bank holds facts about (ADR 0010, ADR 0034): its name, the aliases a match reads, and the folder a match expands. */
const BankEntity = z
  .object({
    name: z.string({ error: "each entity has a name." }).min(1, { error: "each entity has a name." }),
    aliases: z
      .array(z.string().min(1), { error: "each entity lists its aliases, at least one." })
      .min(1, { error: "each entity lists its aliases, at least one." }),
    folder: ScopeFolder.optional(),
  })
  .meta({ description: "An entity a bank holds facts about: its name, its aliases (matched whole-word and case-insensitive against the first message and the repository identity) and, optionally, the scope folder a match expands." });
export type BankEntity = z.infer<typeof BankEntity>;

/** The bank's merge rule (ADR 0035): memories merging on their own or waiting, and the classes that always wait. */
const BankMerge = z
  .object({
    memories: z
      .enum(["auto", "review"], { error: "write.merge.memories is auto or review." })
      .meta({ description: "How a change of only memories lands: auto merges once the bank's check passes; review waits for an owner." }),
    reviewed: z
      .array(z.enum(REVIEWED_CLASSES).meta({ description: "A class of change held for review: orientation, decisions, a status, or the manifest." }), {
        error: `write.merge.reviewed lists the classes that always wait: ${REVIEWED_CLASSES.join(", ")}.`,
      })
      .refine((classes) => REVIEWED_CLASSES.every((kind) => classes.includes(kind)) && new Set(classes).size === classes.length, {
        error: `write.merge.reviewed lists the classes that always wait: ${REVIEWED_CLASSES.join(", ")}.`,
      }),
  })
  .meta({ description: "A bank's own merge rule: memories auto or review, and the reviewed classes, every one of orientation, decisions, status and manifest, which always wait for review." });
export type BankMerge = z.infer<typeof BankMerge>;

const fixed = <const Value extends string>(value: Value, field: string) =>
  z.literal(value, { error: `${field} is ${value}: every bank has the one folder structure.` });

/**
 * A bank's `BANK.md` frontmatter (banks spec, "BANK.md and the folders";
 * ADR 0010, ADR 0034, ADR 0035, ADR 0037). `root: orgs` re-tiers the root
 * breadcrumbs to org headers once a bank outgrows 40 of them (ADR 0013).
 * A team bank names its owners; the retired keys are refused by the
 * validator, not here.
 */
export const BankManifest = z
  .object({
    name: BankName,
    kind: z.enum(BANK_KINDS, { error: "kind is personal or team." }).meta({ description: "A bank's kind: personal (one person's own) or team (shared, reviewed by its owners)." }),
    purpose: oneLine(BANK_CAPS.purpose, "purpose").meta({ description: "The bank line every run sees: what the bank is for, one line of at most 160 characters." }),
    entities: z.array(BankEntity, { error: "entities lists what the bank holds facts about, at least one." }).min(1, { error: "entities lists what the bank holds facts about, at least one." }),
    orientation: z
      .array(MemoryName, { error: `orientation lists at most ${ORIENTATION_CAPS.names} memory names.` })
      .max(ORIENTATION_CAPS.names, { error: `orientation lists at most ${ORIENTATION_CAPS.names} memory names.` })
      .meta({ description: "The memories every session always sees, at most five, each body at most 600 bytes and 1,500 bytes in all." }),
    owners: z
      .array(z.string().regex(/^[^\s/:]+$/), { error: "owners lists the forge logins that review the bank's reviewed changes." })
      .optional()
      .meta({ description: "A team bank's owners: the forge logins that approve its reviewed changes, at least one." }),
    root: z.enum(["orgs"], { error: "root is orgs, or absent." }).optional().meta({ description: "orgs when the bank has re-tiered its root breadcrumbs to org headers, each org then indexing at most 40; absent otherwise." }),
    memories: z
      .object({ glob: fixed(BANK_LAYOUT.glob, "memories.glob"), scope: fixed(BANK_LAYOUT.scope, "memories.scope"), schema: fixed(BANK_LAYOUT.schema, "memories.schema") }, { error: "memories holds glob, scope and schema." })
      .meta({ description: "Where a bank's memories are: the glob, the scope template and the memory schema, the same in every bank." }),
    docs: z
      .object({ globs: z.array(z.string().min(1), { error: "docs.globs lists the bank's documents." }) }, { error: "docs holds globs." })
      .meta({ description: "The bank's documents beside its memories, by glob." }),
    write: z
      .object(
        {
          place: fixed(BANK_LAYOUT.place, "write.place"),
          land: z.enum(["pull-request", "commit"], { error: "write.land is pull-request or commit." }).meta({ description: "How a change lands: pull-request on a forge, commit on a local-only bank's main." }),
          merge: BankMerge,
        },
        { error: "write holds place, land and merge." },
      )
      .meta({ description: "Where a memory is written, how a change lands and the bank's merge rule." }),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.kind === "team" && (manifest.owners === undefined || manifest.owners.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["owners"], message: "a team bank lists its owners, at least one forge login." });
    }
  })
  .meta({ description: "A bank's BANK.md frontmatter: name, kind, purpose, entities, orientation, a team's owners, the memory layout, the documents and the write rule." });
export type BankManifest = z.infer<typeof BankManifest>;

/** An org folder's `ORG.md` frontmatter: its header line (ADR 0037). */
export const OrgFile = z
  .object({ line: oneLine(BANK_CAPS.line, "line").meta({ description: "The org header's one-liner, at most 100 characters." }) })
  .meta({ description: "An org folder's ORG.md frontmatter: line, the org header's one-liner." });
export type OrgFile = z.infer<typeof OrgFile>;

/**
 * A project folder's `PROJECT.md` or an area folder's `AREA.md`
 * frontmatter (ADR 0034, ADR 0037): its breadcrumb's one-liner, its
 * declared topics, and the repositories whose sessions expand it.
 */
export const ScopeFile = z
  .object({
    line: oneLine(BANK_CAPS.line, "line").meta({ description: "The folder's breadcrumb one-liner, at most 100 characters." }),
    topics: z
      .record(TopicName, oneLine(BANK_CAPS.line, "a topic's one-liner"), { error: "topics maps each topic to its one-liner; {} for none." })
      .meta({ description: "The folder's declared topics, each a lower-case slug mapped to its one-liner of at most 100 characters; {} for none." }),
    repos: z
      .array(RepositoryIdentity, { error: "repos lists repository identities." })
      .optional()
      .meta({ description: "The repository identities whose sessions open with this folder expanded." }),
  })
  .meta({ description: "A project's PROJECT.md or an area's AREA.md frontmatter: line, topics and repos." });
export type ScopeFile = z.infer<typeof ScopeFile>;

/** A memory's frontmatter (banks spec, "BANK.md and the folders"): name, description, type and the repositories it applies to. */
export const MemoryFrontmatter = z
  .object({
    name: MemoryName,
    description: z
      .string({ error: "description is 60 to 160 characters." })
      .min(BANK_CAPS.description.min, { error: "description is 60 to 160 characters." })
      .max(BANK_CAPS.description.max, { error: "description is 60 to 160 characters." })
      .meta({ description: "What a run matches the memory by: 60 to 160 characters, opening with a trigger word, unique in its folder." }),
    metadata: z
      .object(
        {
          type: z.enum(MEMORY_TYPES, { error: `metadata.type is one of ${MEMORY_TYPES.join(", ")}.` }).meta({ description: "A memory's type: user, feedback, project or reference." }),
          applies_to: z
            .array(RepositoryIdentity, { error: "metadata.applies_to lists repository identities." })
            .optional()
            .meta({ description: "The repository identities the memory applies to; absent for everywhere." }),
        },
        { error: `metadata holds the memory's type, one of ${MEMORY_TYPES.join(", ")}.` },
      )
      .meta({ description: "A memory's metadata: its type and the repositories it applies to." }),
  })
  .meta({ description: "A memory's frontmatter: name, description and metadata (type, applies_to). The body after it is at most 6,000 characters." });
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatter>;

/** The validator's rules, by id, each a refusal or a warning, in the order the validator reports them. */
export const BANK_RULE_IDS = [
  "unreadable",
  "manifest_missing",
  "manifest_malformed",
  "manifest_fact_missing",
  "manifest_fact_invalid",
  "retired_key",
  "unknown_scope_label",
  "orientation_over_cap",
  "orientation_missing",
  "orientation_too_large",
  "scope_file_missing",
  "scope_file_malformed",
  "scope_line",
  "scope_topics",
  "unknown_scope",
  "undeclared_topic",
  "repository_identity",
  "index_over_cap",
  "root_over_cap",
  "memory_malformed",
  "memory_name",
  "memory_name_taken",
  "memory_type",
  "description_length",
  "description_is_name",
  "description_duplicate",
  "body_too_long",
  "secret_shaped",
  "description_trigger",
  "unresolved_link",
] as const;
export const BankRuleId = z.enum(BANK_RULE_IDS).meta({ description: "A bank validator rule's id; data/bank-validator-rules.json says what each refuses or warns of." });
export type BankRuleId = z.infer<typeof BankRuleId>;

/** Whether a finding refuses the bank (or the write) or only warns. */
const BankFindingSeverity = z.enum(["refusal", "warning"]).meta({ description: "refusal: the bank or the write is refused; warning: reported, nothing refused." });
export type BankFindingSeverity = z.infer<typeof BankFindingSeverity>;

/** One of the validator's rules: its id, its severity, and what it refuses or warns of, as published. */
export const BankValidatorRule = z
  .object({ id: BankRuleId, severity: BankFindingSeverity, summary: z.string().min(1) })
  .meta({ description: "A bank validator rule: its id, whether it refuses or warns, and what it finds, with how a bank author answers it." });
export type BankValidatorRule = z.infer<typeof BankValidatorRule>;

const refusal = (summary: string) => ({ severity: "refusal", summary }) as const;
const warning = (summary: string) => ({ severity: "warning", summary }) as const;

/** What each rule finds and how a bank author answers it (ADR 0013, ADR 0034, ADR 0037; key-managers spec for secret_shaped). */
const RULE_SUMMARIES: Record<BankRuleId, Omit<BankValidatorRule, "id">> = {
  unreadable: refusal("A file the validator reads (BANK.md, or Markdown under projects/) or a folder holding them is there but could not be read: a permission, a link to nothing, or a link back to a folder it is in. The finding names the error and the verdict is on the bank without it: make it readable, or remove it."),
  manifest_missing: refusal("The bank has no BANK.md at its root: write one with its name, kind, purpose, entities, orientation, memories, docs and write."),
  manifest_malformed: refusal("BANK.md's frontmatter does not parse as a YAML mapping between --- lines."),
  manifest_fact_missing: refusal("BANK.md lacks a fact it must hold: name, kind, purpose, entities each with aliases, orientation, memories, docs, write, and a team bank's owners."),
  manifest_fact_invalid: refusal("A fact in BANK.md has the wrong shape: a name that is no lower-case slug of 1 to 40 characters, a purpose over 160 characters, an unknown kind or landing, the merge rule, or a layout other than the one every bank has."),
  retired_key: refusal("A key the new ones replace: description and index in BANK.md (purpose replaces description; INDEX.md is dropped), summary and code in a folder file (line and repos replace them)."),
  unknown_scope_label: refusal("A scope or write template in BANK.md uses a label other than org, project, area, topic and name."),
  orientation_over_cap: refusal("BANK.md's orientation lists more than five memory names."),
  orientation_missing: refusal("An orientation name in BANK.md names no memory in the bank."),
  orientation_too_large: refusal("An orientation memory's body is over 600 bytes of UTF-8, or the orientation memories' bodies are over 1,500 bytes in all: write orientation as short pointers."),
  scope_file_missing: refusal("A folder at a scope level has no file of its level: ORG.md in an org, PROJECT.md in a project, AREA.md in an area holding memories."),
  scope_file_malformed: refusal("A folder file's frontmatter does not parse as a YAML mapping between --- lines."),
  scope_line: refusal("A folder file has no line:, or one that is not a single line of at most 100 characters."),
  scope_topics: refusal("A PROJECT.md or AREA.md has no topics: map ({} for none), or a topic that is not a lower-case slug with a one-liner of at most 100 characters."),
  unknown_scope: refusal("A file or an entity's folder: is at no place the structure projects/{org}/{project}[/{area}]/memories/[{topic}/] has, or names a scope folder the bank does not have."),
  undeclared_topic: refusal("A memory sits in a topic its folder's PROJECT.md or AREA.md does not declare in topics:."),
  repository_identity: refusal("A repos: or applies_to entry is not a repository identity (https://host/owner/name, lower case): a directory name or another spelling."),
  index_over_cap: refusal("A folder's or topic's index is over 40 lines: file the memory under one of the folder's topics, or declare a new topic in its topics: map."),
  root_over_cap: refusal("The root breadcrumbs (one per project or area holding memories) are over 40 lines: re-tier the root to orgs with root: orgs in BANK.md; after that, an org over 40 is refused the same way."),
  memory_malformed: refusal("A memory's frontmatter does not parse as a YAML mapping between --- lines."),
  memory_name: refusal("A memory's name is missing, is no lower-case slug of at most 60 characters, or differs from its file's name."),
  memory_name_taken: refusal("Two memories in the bank have one name: a name points at one memory."),
  memory_type: refusal("A memory's metadata.type is missing or not one of user, feedback, project and reference."),
  description_length: refusal("A memory's description is missing or outside 60 to 160 characters."),
  description_is_name: refusal("A memory's description is its name re-cased: say what the memory is for and when to read it."),
  description_duplicate: refusal("Two memories in one folder or topic have one description: each must be told apart from the others."),
  body_too_long: refusal("A memory's body is over 6,000 characters: split it into memories of one fact each."),
  secret_shaped: refusal("A file holds a secret: a shape rule's hit or a value the environment holds as a secret, named by the rule and the field, never by the value. Move it to the key manager and name its path."),
  description_trigger: warning("A memory's description does not open with a trigger word (Before, When, After, While, If, Where, How, What, Which, Why)."),
  unresolved_link: warning("A [[name]] link in a memory names no memory in the bank."),
};

/** The validator's rules in their order, as `data/bank-validator-rules.json` publishes them. */
export const BANK_VALIDATOR_RULES: readonly BankValidatorRule[] = BANK_RULE_IDS.map((id) => ({ id, ...RULE_SUMMARIES[id] }));

/** One thing the validator found: the rule, its severity, where, and a sentence for the bank's author. */
export const BankFinding = z
  .object({
    rule: BankRuleId,
    severity: BankFindingSeverity,
    path: z.string().meta({ description: "The file or folder it is about, relative to the bank's root: BANK.md, projects/acme/web/, or a memory's file." }),
    field: z.string().min(1).optional().meta({ description: "The field of the file it is about, where it is one: purpose, orientation, topics, description, body." }),
    secret: SecretRule.optional().meta({ description: "secret_shaped only: the shape rule that found it, or registered-value; never the value." }),
    message: z.string().min(1).meta({ description: "What is wrong and what to do, for the bank's author; never a secret's value." }),
  })
  .meta({ description: "One finding of the bank validator: the rule's id, refusal or warning, the path and field it is about, and an actionable message." });
export type BankFinding = z.infer<typeof BankFinding>;

/** The validator's one verdict on a bank or a write: the rules' version, whether nothing was refused, and every finding. */
export const BankVerdict = z
  .object({
    validator: z.object({ name: z.literal(BANK_VALIDATOR.name), version: z.number().int().min(1) }).meta({ description: "The validator and the version of its rules that gave the verdict." }),
    valid: z.boolean().meta({ description: "True when no finding is a refusal." }),
    findings: z.array(BankFinding).meta({ description: "Every finding, refusals and warnings, in the rules' order, then by path." }),
  })
  .meta({ description: "The bank validator's verdict, the same from the functions, the BankService and the vendored validate.mjs." });
export type BankVerdict = z.infer<typeof BankVerdict>;

/**
 * The stamp the built `validate.mjs` opens with, and the version a bank's
 * vendored copy carries: `// bank-validator 1`, the validator's name and
 * the version of its rules.
 */
export const bankValidatorStamp = (validator: { readonly name: string; readonly version: number } = BANK_VALIDATOR): string => `// ${validator.name} ${validator.version}`;

/** The validator and rules version a vendored `validate.mjs` is stamped with, read from its first line; null for a file with no stamp. */
export const readBankValidatorStamp = (text: string): { readonly name: string; readonly version: number } | null => {
  const match = /^\/\/ ([a-z][a-z0-9-]*) ([1-9][0-9]*)(?:\r?\n|$)/.exec(text);
  return match?.[1] === undefined || match[2] === undefined ? null : { name: match[1], version: Number(match[2]) };
};
