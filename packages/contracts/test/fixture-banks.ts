import { stringify } from "yaml";
import type { BankRuleId } from "../src/index.js";

/**
 * Fixture banks for the bank validator (banks spec, "Testing Decisions"):
 * a personal and a team bank on the structure contract, each file by its
 * path from the bank's root, and for every rule a bank that breaks it once.
 * The functions' tests and the built `validate.mjs`'s read the same ones.
 */

/** A bank's files, by path from its root, `/`-separated. */
export type FixtureBank = Readonly<Record<string, string>>;

/** A Markdown file of `frontmatter` and `body`. */
export const markdown = (frontmatter: Record<string, unknown>, body = ""): string => `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${body}`;

/** A memory's file. */
export const memory = (
  name: string,
  { description = `When you need the ${name} fact - the one place it is written down for runs`, type = "project", body = `The ${name} fact, measured 2026-09-30.\n`, appliesTo }: { description?: string; type?: string; body?: string; appliesTo?: readonly string[] } = {},
): string => markdown({ name, description, metadata: { type, ...(appliesTo && { applies_to: appliesTo }) } }, body);

/** A project's or an area's file. */
export const scopeFile = (line: string, topics: Record<string, string> = {}, repos?: readonly string[]): string => markdown({ line, topics, ...(repos && { repos }) }, "\n# The folder\n");

const LAYOUT = {
  memories: { glob: "projects/**/memories/**/*.md", scope: "projects/{org}/{project}[/{area}]/", schema: "memory" },
  docs: { globs: ["projects/**/{PROJECT,AREA,HANDOFF}.md", "reference/**/*.md"] },
};

const WRITE = { place: "projects/{org}/{project}[/{area}]/memories/[{topic}/]{name}.md", land: "pull-request", merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] } };

/** A personal bank's manifest, with `changes` over it. */
export const personalManifest = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "maya-memory",
  kind: "personal",
  purpose: "Maya Reyes's private memory: her machines, projects and companies. Team facts go to the team's own bank.",
  entities: [
    { name: "Maya Reyes", aliases: ["maya-reyes", "Maya"] },
    { name: "Homelab", aliases: ["home lab", "nas"], folder: "personal/homelab/" },
  ],
  orientation: ["secrets-layout", "machines-at-a-glance"],
  ...LAYOUT,
  write: WRITE,
  ...changes,
});

/** 600 bytes of UTF-8 in 300 code points: a body at the orientation cap, two bytes a character. */
const AT_THE_CAP = "é".repeat(300);

/**
 * A personal bank on the contract: an org with its home folder, a project
 * with a topic and an area, memories at each, documents beside them, and
 * an orientation memory exactly at the 600-byte cap in two-byte characters.
 */
export const PERSONAL_BANK: FixtureBank = {
  "BANK.md": markdown(personalManifest(), "\n# How agents use this bank\n\nThe body.\n"),
  "README.md": "# maya-memory\n",
  "reference/conventions.md": "# Conventions\n",
  "projects/personal/ORG.md": markdown({ line: "Maya's own work: her machines and side projects" }),
  "projects/personal/memory-bank/PROJECT.md": scopeFile("The bank's own facts: where secrets live and what the machines are"),
  "projects/personal/memory-bank/memories/secrets-layout.md": memory("secrets-layout", {
    description: "Before using or storing any credential - where Maya's secrets live in the key manager",
    type: "reference",
    body: AT_THE_CAP,
  }),
  "projects/personal/memory-bank/memories/machines-at-a-glance.md": memory("machines-at-a-glance", {
    description: "When a task names a machine - Maya's machines at a glance, one line each, with pointers",
    type: "reference",
    body: "The laptop and the NAS; see [[nas-disk-layout]].\n",
  }),
  "projects/personal/homelab/PROJECT.md": scopeFile("Maya's homelab: the NAS, its backups and the deploys", { deploys: "Before a deploy or rollback - the pipeline and its traps" }, [
    "https://github.com/maya-reyes/homelab",
  ]),
  "projects/personal/homelab/HANDOFF.md": "# Handoff\n",
  "projects/personal/homelab/memories/backup-schedule.md": memory("backup-schedule", {
    // 60 characters exactly.
    description: "When a backup is missing - the nightly schedule and its logs",
    appliesTo: ["https://github.com/maya-reyes/homelab"],
  }),
  "projects/personal/homelab/memories/deploys/rollback-steps.md": memory("rollback-steps", {
    // 160 characters exactly.
    description: "Before rolling back a deploy on the homelab - the three steps that undo it, in order, and the one trap that loses the database volume if you skip the first step",
  }),
  "projects/personal/homelab/nas/AREA.md": scopeFile("The NAS: its disks, shares and the parity check"),
  "projects/personal/homelab/nas/memories/nas-disk-layout.md": memory("nas-disk-layout", { description: "Where each NAS disk sits and what it holds - read before replacing or adding a disk" }),
};

/** A team bank's manifest, with `changes` over it. */
export const teamManifest = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "acme",
  kind: "team",
  purpose: "The Acme team's shared facts, a folder per project. Shared with the team; no personal facts, no secrets.",
  entities: [
    { name: "Acme", aliases: ["acme", "acme.example"], folder: "acme/" },
    { name: "Acme Web", aliases: ["acme-web", "the storefront"], folder: "acme/web/" },
  ],
  orientation: ["where-work-is-tracked"],
  owners: ["maya-reyes", "sam-ortiz"],
  ...LAYOUT,
  write: WRITE,
  ...changes,
});

/** Forty memories: a folder's index at its cap. */
const FORTY = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => {
    const name = `storefront-fact-${String(i + 1).padStart(2, "0")}`;
    return [`projects/acme/web/memories/${name}.md`, memory(name, { description: `When the storefront needs fact ${i + 1} - the forty-line folder at its cap`, appliesTo: ["https://github.com/acme/web"] })];
  }),
);

/** A team bank on the contract: owners, an org with its home folder, and a project whose index is at its 40-line cap. */
export const TEAM_BANK: FixtureBank = {
  "BANK.md": markdown(teamManifest(), "\n# How agents use this bank\n"),
  "projects/acme/ORG.md": markdown({ line: "The Acme team" }),
  "projects/acme/bank/PROJECT.md": scopeFile("The bank's own facts: accounts, secrets layout and where work is tracked"),
  "projects/acme/bank/memories/where-work-is-tracked.md": memory("where-work-is-tracked", {
    description: "Before filing or picking up Acme work - which tracker holds it and how issues are labelled",
    type: "reference",
    body: "The tracker on the team's forge; labels by project.\n",
  }),
  "projects/acme/web/PROJECT.md": scopeFile("The storefront: its theme, checkout and the deploy pipeline", {}, ["https://github.com/acme/web"]),
  ...FORTY,
};

/** `bank` with `changes`: a file by path replaced, or removed for null. */
export const changed = (bank: FixtureBank, changes: Readonly<Record<string, string | null>>): FixtureBank => {
  const files: Record<string, string> = { ...bank };
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) delete files[path];
    else files[path] = text;
  }
  return files;
};

/** The personal bank's manifest file with `changes`, keys set to undefined left out. */
const personalWith = (changes: Record<string, unknown>): FixtureBank => {
  const manifest = Object.fromEntries(Object.entries(personalManifest(changes)).filter(([, value]) => value !== undefined));
  return changed(PERSONAL_BANK, { "BANK.md": markdown(manifest) });
};

const HOMELAB = "projects/personal/homelab";

/** A GitHub token's shape, fake, its prefix kept apart from its body in the source. */
export const FAKE_GITHUB_TOKEN = ["gh", "p_", "Fake0Test9".repeat(4).slice(0, 36)].join("");

/** Forty-one root breadcrumbs: projects holding a memory each, beside the personal bank's three. */
const rootOf = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const project = `side-${String(i + 1).padStart(2, "0")}`;
      return [
        [`projects/personal/${project}/PROJECT.md`, scopeFile(`Side project ${i + 1}`)],
        [`projects/personal/${project}/memories/${project}-fact.md`, memory(`${project}-fact`)],
      ];
    }).flat(),
  );

/** One bank per rule, each breaking it once, and the path the finding names; with the files in it that could not be read, by path, each with why. */
export const RULE_FIXTURES: Record<BankRuleId, { readonly bank: FixtureBank; readonly path: string; readonly unreadable?: Readonly<Record<string, string>> }> = {
  // A link to nothing, as validate.mjs finds one in a checkout: no file to read, even for root.
  unreadable: { bank: PERSONAL_BANK, unreadable: { [`${HOMELAB}/memories/restore-drill.md`]: "ENOENT" }, path: `${HOMELAB}/memories/restore-drill.md` },
  manifest_missing: { bank: changed(PERSONAL_BANK, { "BANK.md": null }), path: "BANK.md" },
  manifest_malformed: { bank: changed(PERSONAL_BANK, { "BANK.md": "---\nname: [unclosed\n---\n" }), path: "BANK.md" },
  manifest_fact_missing: { bank: personalWith({ purpose: undefined }), path: "BANK.md" },
  manifest_fact_invalid: { bank: personalWith({ name: "Maya Memory" }), path: "BANK.md" },
  retired_key: { bank: personalWith({ description: "The old key purpose replaces." }), path: "BANK.md" },
  unknown_scope_label: { bank: personalWith({ write: { ...WRITE, place: "brands/{brand}/{system}/memories/{name}.md" } }), path: "BANK.md" },
  orientation_over_cap: { bank: personalWith({ orientation: ["secrets-layout", "machines-at-a-glance", "backup-schedule", "rollback-steps", "nas-disk-layout", "secrets-layout"] }), path: "BANK.md" },
  orientation_missing: { bank: personalWith({ orientation: ["secrets-layout", "where-work-is-tracked"] }), path: "BANK.md" },
  orientation_too_large: {
    bank: changed(PERSONAL_BANK, {
      "projects/personal/memory-bank/memories/secrets-layout.md": memory("secrets-layout", {
        description: "Before using or storing any credential - where Maya's secrets live in the key manager",
        type: "reference",
        body: `${AT_THE_CAP}é`,
      }),
    }),
    path: "projects/personal/memory-bank/memories/secrets-layout.md",
  },
  scope_file_missing: { bank: changed(PERSONAL_BANK, { "projects/personal/homelab/nas/AREA.md": null }), path: "projects/personal/homelab/nas/" },
  scope_file_malformed: { bank: changed(PERSONAL_BANK, { "projects/personal/ORG.md": "---\nline: [\n---\n" }), path: "projects/personal/ORG.md" },
  scope_line: { bank: changed(PERSONAL_BANK, { "projects/personal/ORG.md": markdown({ line: "x".repeat(101) }) }), path: "projects/personal/ORG.md" },
  scope_topics: { bank: changed(PERSONAL_BANK, { "projects/personal/homelab/nas/AREA.md": markdown({ line: "The NAS" }) }), path: "projects/personal/homelab/nas/AREA.md" },
  unknown_scope: { bank: changed(PERSONAL_BANK, { "projects/personal/memories/stray.md": memory("stray") }), path: "projects/personal/memories/stray.md" },
  undeclared_topic: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backups/restore-test.md`]: memory("restore-test") }), path: `${HOMELAB}/memories/backups/restore-test.md` },
  repository_identity: {
    bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { description: "When a backup is missing - the nightly schedule and its logs", appliesTo: ["homelab"] }) }),
    path: `${HOMELAB}/memories/backup-schedule.md`,
  },
  index_over_cap: { bank: changed(TEAM_BANK, { "projects/acme/web/memories/storefront-fact-41.md": memory("storefront-fact-41") }), path: "projects/acme/web/" },
  root_over_cap: { bank: changed(PERSONAL_BANK, rootOf(38)), path: "projects/" },
  memory_malformed: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: "---\nname: backup-schedule\ndescription: [\n---\nBody\n" }), path: `${HOMELAB}/memories/backup-schedule.md` },
  memory_name: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-plan") }), path: `${HOMELAB}/memories/backup-schedule.md` },
  memory_name_taken: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/nas/memories/backup-schedule.md`]: memory("backup-schedule", { description: "When the NAS's own backup is missing - its schedule, apart from the homelab's" }) }), path: `${HOMELAB}/nas/memories/backup-schedule.md` },
  memory_type: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { type: "note" }) }), path: `${HOMELAB}/memories/backup-schedule.md` },
  description_length: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { description: "When a backup is missing - the nightly schedule and its log" }) }), path: `${HOMELAB}/memories/backup-schedule.md` },
  description_is_name: {
    bank: changed(PERSONAL_BANK, {
      [`${HOMELAB}/memories/when-the-nightly-backup-is-missing-read-the-schedule-and-log.md`]: memory("when-the-nightly-backup-is-missing-read-the-schedule-and-log", {
        description: "When the nightly backup is missing, read the schedule and log",
      }),
    }),
    path: `${HOMELAB}/memories/when-the-nightly-backup-is-missing-read-the-schedule-and-log.md`,
  },
  description_duplicate: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-logs.md`]: memory("backup-logs", { description: "When a backup is missing - the nightly schedule and its logs" }) }), path: `${HOMELAB}/memories/backup-logs.md` },
  body_too_long: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { body: "x".repeat(6_001) }) }), path: `${HOMELAB}/memories/backup-schedule.md` },
  secret_shaped: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { body: `The token is ${FAKE_GITHUB_TOKEN} for now.\n` }) }), path: `${HOMELAB}/memories/backup-schedule.md` },
  description_trigger: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { description: "The nightly backup schedule and its logs, for when a backup is missing" }) }), path: `${HOMELAB}/memories/backup-schedule.md` },
  unresolved_link: { bank: changed(PERSONAL_BANK, { [`${HOMELAB}/memories/backup-schedule.md`]: memory("backup-schedule", { body: "See [[restore-drill]].\n" }) }), path: `${HOMELAB}/memories/backup-schedule.md` },
};
