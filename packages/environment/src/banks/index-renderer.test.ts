import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BankKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { markdown, memory, PERSONAL_BANK, personalManifest, scopeFile, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { git } from "../../test/workspaces.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex, type BankRole } from "./bank-index.js";
import { readPointer, renderTrail, type Relevance } from "./index-renderer.js";

/**
 * The IndexRenderer at its lower seam (banks spec, "Rendering the index"
 * and "Testing Decisions"; ADR 0013, ADR 0037): fixture banks committed to
 * git repositories on disk, read as the environment reads a checkout, and
 * the renderer's public answers, the trail's text and a pointer's read.
 */

const { tempDir } = useCleanups();

/** A git repository holding `files` in one commit on main. */
const gitBank = (files: Readonly<Record<string, string>>): string => {
  const root = tempDir("agent-harness-bank-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

/** The fixture bank `files` committed and read back, as the registry would name it. */
const bankOf = async (files: Readonly<Record<string, string>>, { name = "maya-memory", kind = "personal", role = "read-write" }: { name?: string; kind?: BankKind; role?: BankRole } = {}): Promise<BankIndex> =>
  indexBank({ name, kind, role, files: await readBankFiles(gitBank(files)) });

const PURPOSE = "Maya Reyes's private memory: her machines, projects and companies. Team facts go to the team's own bank.";
const TEAM_PURPOSE = "The Acme team's shared facts, a folder per project. Shared with the team; no personal facts, no secrets.";

/** `lines` as the renderer prints them: each ending in a newline. */
const text = (...lines: string[]): string => lines.map((line) => `${line}\n`).join("");

const HOMELAB = "- maya-memory:personal/homelab/ (2) — Maya's homelab: the NAS, its backups and the deploys";
const DEPLOYS = "- maya-memory:personal/homelab/memories/deploys/ (1) — Before a deploy or rollback - the pipeline and its traps";
const BACKUP = "- maya-memory:backup-schedule — When a backup is missing - the nightly schedule and its logs";
const ROLLBACK =
  "- maya-memory:rollback-steps — Before rolling back a deploy on the homelab - the three steps that undo it, in order, and the one trap that loses the database volume if you skip the first step";
const NAS_DISKS = "- maya-memory:nas-disk-layout — Where each NAS disk sits and what it holds - read before replacing or adding a disk";
const PERSONAL_ORG = "### maya-memory:personal/ (5) — Maya's own work: her machines and side projects";
const NAS = "- maya-memory:personal/homelab/nas/ (1) — The NAS: its disks, shares and the parity check";
const MEMORY_BANK = "- maya-memory:personal/memory-bank/ (2) — The bank's own facts: where secrets live and what the machines are";

describe("the bank trail", () => {
  it("renders the bank line, every orientation fact and one breadcrumb per folder holding memories under its counted org header", async () => {
    const trail = renderTrail([await bankOf(PERSONAL_BANK)]);
    expect(trail.text).toBe(
      [
        `## maya-memory (personal, read-write) — 5 memories in 3 folders — ${PURPOSE}`,
        "- maya-memory:secrets-layout",
        `  ${"é".repeat(300)}`,
        "- maya-memory:machines-at-a-glance",
        "  The laptop and the NAS; see [[nas-disk-layout]].",
        "### maya-memory:personal/ (5) — Maya's own work: her machines and side projects",
        "- maya-memory:personal/homelab/ (2) — Maya's homelab: the NAS, its backups and the deploys",
        "- maya-memory:personal/homelab/nas/ (1) — The NAS: its disks, shares and the parity check",
        "- maya-memory:personal/memory-bank/ (2) — The bank's own facts: where secrets live and what the machines are",
        "",
      ].join("\n"),
    );
    expect(trail).toMatchObject({ lines: 9, bytes: Buffer.byteLength(trail.text) });
  });
});

describe("reading a pointer", () => {
  it("reads every bank's line with no pointer, and a bare bank's root, its line, orientation and breadcrumbs", async () => {
    const banks = [await bankOf(TEAM_BANK, { name: "acme", kind: "team", role: "read-only" }), await bankOf(PERSONAL_BANK)];
    expect(readPointer(banks)).toEqual({
      found: true,
      text: text(`## acme (team, read-only) — 41 memories in 2 folders — ${TEAM_PURPOSE}`, `## maya-memory (personal, read-write) — 5 memories in 3 folders — ${PURPOSE}`),
    });
    expect(readPointer(banks, "acme")).toEqual({
      found: true,
      text: text(
        `## acme (team, read-only) — 41 memories in 2 folders — ${TEAM_PURPOSE}`,
        "- acme:where-work-is-tracked",
        "  The tracker on the team's forge; labels by project.",
        "### acme:acme/ (41) — The Acme team",
        "- acme:acme/bank/ (1) — The bank's own facts: accounts, secrets layout and where work is tracked",
        "- acme:acme/web/ (40) — The storefront: its theme, checkout and the deploy pipeline",
      ),
    });
  });

  it("reads an org as its group, a folder and a topic as their index, and a memory as its file, each ending with the folder holding it and its count", async () => {
    const banks = [await bankOf(PERSONAL_BANK)];
    expect(readPointer(banks, "maya-memory:personal/")).toEqual({ found: true, text: text(PERSONAL_ORG, HOMELAB, NAS, MEMORY_BANK, "", `In maya-memory (5) — ${PURPOSE}`) });
    expect(readPointer(banks, "maya-memory:personal/homelab/")).toEqual({
      found: true,
      text: text(HOMELAB, `  ${DEPLOYS}`, `  ${BACKUP}`, "", "In maya-memory:personal/ (5) — Maya's own work: her machines and side projects"),
    });
    expect(readPointer(banks, "maya-memory:personal/homelab/memories/deploys/")).toEqual({ found: true, text: text(DEPLOYS, `  ${ROLLBACK}`, "", `In ${HOMELAB.slice(2)}`) });
    expect(readPointer(banks, "maya-memory:rollback-steps")).toEqual({ found: true, text: `${PERSONAL_BANK["projects/personal/homelab/memories/deploys/rollback-steps.md"]}\nIn ${DEPLOYS.slice(2)}\n` });
    expect(readPointer(banks, " maya-memory:backup-schedule ")).toEqual({ found: true, text: `${PERSONAL_BANK["projects/personal/homelab/memories/backup-schedule.md"]}\nIn ${HOMELAB.slice(2)}\n` });
  });

  it.each([
    ["maya-memory:Backup Schedule", "maya-memory:Backup Schedule is not a pointer: name a bank, bank:path/ for a folder or a topic, or bank:name for a memory."],
    ["cortex:homelab/", "No bank in scope is named cortex: the banks are maya-memory."],
    ["maya-memory:personal/garden/", "maya-memory:personal/garden/ names nothing in maya-memory: read maya-memory for its folders."],
    ["maya-memory:restore-drill", "maya-memory:restore-drill names nothing in maya-memory: read maya-memory for its folders."],
  ])("answers why %s reads nothing", async (pointer, message) => {
    expect(readPointer([await bankOf(PERSONAL_BANK)], pointer)).toEqual({ found: false, message });
  });
});

/** A personal bank with an org `personal` holding a project per entry, each with `count` memories, its `repos:` and its topics. */
const projectsBank = (
  projects: Readonly<Record<string, { readonly count: number; readonly repos?: readonly string[] }>>,
  manifest: Record<string, unknown> = {},
): Record<string, string> => ({
  "BANK.md": markdown(personalManifest({ orientation: [], ...manifest })),
  "projects/personal/ORG.md": markdown({ line: "Maya's own work" }),
  ...Object.fromEntries(
    Object.entries(projects).flatMap(([project, { count, repos }]) => [
      [`projects/personal/${project}/PROJECT.md`, scopeFile(`The ${project} project`, {}, repos)],
      ...Array.from({ length: count }, (_, i) => [`projects/personal/${project}/memories/${project}-fact-${i + 1}.md`, memory(`${project}-fact-${i + 1}`)]),
    ]),
  ),
});

/** The lines of a project folder of `projectsBank`, as its breadcrumb or as its index. */
const crumb = (project: string, count: number, marker = ""): string => `- maya-memory:personal/${project}/ (${count}) — The ${project} project${marker}`;
const expansion = (project: string, count: number): string[] => [
  crumb(project, count),
  ...Array.from({ length: count }, (_, i) => `  - maya-memory:${project}-fact-${i + 1} — When you need the ${project}-fact-${i + 1} fact - the one place it is written down for runs`),
];

describe("relevance", () => {
  it("expands a folder whose repos: lists the session's repository, and its areas, each exactly as reading it answers", async () => {
    const bank = await bankOf(PERSONAL_BANK);
    const trail = renderTrail([bank], { repositoryIdentity: "https://github.com/maya-reyes/homelab" });
    const homelab = text(HOMELAB, `  ${DEPLOYS}`, `  ${BACKUP}`);
    const nas = text(NAS, `  ${NAS_DISKS}`);
    expect(trail.text.endsWith(text(PERSONAL_ORG) + homelab + nas + text(MEMORY_BANK))).toBe(true);
    for (const [pointer, index] of [
      ["maya-memory:personal/homelab/", homelab],
      ["maya-memory:personal/homelab/nas/", nas],
    ] as const) {
      const read = readPointer([bank], pointer);
      expect(read.found && read.text.startsWith(`${index}\n`)).toBe(true);
    }
    expect(renderTrail([bank], { repositoryIdentity: "https://github.com/maya-reyes/garden" }).text).toBe(renderTrail([bank]).text);
  });

  const FIVE = projectsBank(
    { alpha: { count: 2 }, bravo: { count: 2 }, charlie: { count: 2, repos: ["https://github.com/maya-reyes/charlie"] }, delta: { count: 2 }, echo: { count: 2 }, foxtrot: { count: 1 } },
    { entities: [{ name: "Delta Rig", aliases: ["the rig"], folder: "personal/delta/" }] },
  );
  const ALL = {
    registryPins: ["maya-memory:personal/alpha/"],
    sessionPins: ["maya-memory:personal/bravo/"],
    repositoryIdentity: "https://github.com/maya-reyes/charlie",
    firstMessage: "Why is THE RIG offline?",
    recentUse: ["maya-memory:echo-fact-1"],
  } satisfies Relevance;
  // The bank line, the org header and six breadcrumbs, and room for one index of two memories more.
  const ONE_MORE = { lines: 10, bytes: 20 * 1024 };

  it.each<[string, Relevance, string]>([
    ["a registry pin", ALL, "alpha"],
    ["a session pin", { ...ALL, registryPins: [] }, "bravo"],
    ["the repository", { ...ALL, registryPins: [], sessionPins: [] }, "charlie"],
    ["an entity", { ...ALL, registryPins: [], sessionPins: [], repositoryIdentity: null }, "delta"],
    ["recent use", { recentUse: ALL.recentUse }, "echo"],
  ])("expands the folder %s names first, and marks each other relevant folder that does not fit with why", async (_, relevance, first) => {
    const markers: Record<string, string> = {
      alpha: " [pinned]",
      bravo: " [pinned]",
      charlie: " [matches this repository]",
      delta: " [matches Delta Rig]",
      echo: " [used this session]",
    };
    const relevant = new Set(
      Object.entries({ alpha: relevance.registryPins, bravo: relevance.sessionPins, charlie: relevance.repositoryIdentity, delta: relevance.firstMessage, echo: relevance.recentUse })
        .filter(([, fact]) => fact !== undefined && fact !== null && fact.length > 0)
        .map(([project]) => project),
    );
    const trail = renderTrail([await bankOf(FIVE)], relevance, ONE_MORE);
    expect(trail.text).toBe(
      text(
        `## maya-memory (personal, read-write) — 11 memories in 6 folders — ${PURPOSE}`,
        "### maya-memory:personal/ (11) — Maya's own work",
        ...["alpha", "bravo", "charlie", "delta", "echo"].flatMap((project) => (project === first ? expansion(project, 2) : [crumb(project, 2, relevant.has(project) ? markers[project] : "")])),
        crumb("foxtrot", 1),
      ),
    );
    expect(trail.lines).toBe(10);
  });

  it("breaks a tie by fewer lines: the smaller of two folders matching the repository expands first", async () => {
    const both = ["https://github.com/maya-reyes/shared"];
    const bank = await bankOf(projectsBank({ big: { count: 3, repos: both }, small: { count: 1, repos: both } }));
    // The bank line, the header and two breadcrumbs, and three lines more: the big folder's index alone would fit.
    expect(renderTrail([bank], { repositoryIdentity: "https://github.com/maya-reyes/shared" }, { lines: 7, bytes: 20 * 1024 }).text).toBe(
      text(
        `## maya-memory (personal, read-write) — 4 memories in 2 folders — ${PURPOSE}`,
        "### maya-memory:personal/ (4) — Maya's own work",
        crumb("big", 3, " [matches this repository]"),
        ...expansion("small", 1),
      ),
    );
  });

  it.each([
    ["the first message, in another case", { firstMessage: "The NAS is full again" }, true],
    ["a multi-word alias", { firstMessage: "is the home lab down?" }, true],
    ["the entity's name", { firstMessage: "Homelab: what runs there?" }, true],
    ["the repository identity", { repositoryIdentity: "https://github.com/maya-reyes/nas-tools" }, true],
    ["only part of a word", { firstMessage: "a nasty bug in the homelabs and the nastier one" }, false],
    ["nothing", { firstMessage: "Plan the week" }, false],
  ])("matches an entity's aliases and name as whole words in %s", async (_, relevance, matches) => {
    const bank = await bankOf(PERSONAL_BANK);
    const trail = renderTrail([bank], relevance).text;
    expect(trail.includes(text(HOMELAB, `  ${DEPLOYS}`, `  ${BACKUP}`, NAS, `  ${NAS_DISKS}`))).toBe(matches);
    if (!matches) expect(trail).toBe(renderTrail([bank]).text);
  });

  it("expands a pinned topic's folder alone, and ignores a pin on another bank", async () => {
    const bank = await bankOf(PERSONAL_BANK);
    const trail = renderTrail([bank], { sessionPins: ["maya-memory:personal/homelab/memories/deploys/", "acme:acme/web/"] }).text;
    expect(trail.endsWith(text(PERSONAL_ORG, HOMELAB, `  ${DEPLOYS}`, `  ${BACKUP}`, NAS, MEMORY_BANK))).toBe(true);
  });
});
