import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BankKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { PERSONAL_BANK, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { git } from "../../test/workspaces.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex, type BankRole } from "./bank-index.js";
import { readPointer, renderTrail } from "./index-renderer.js";

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
