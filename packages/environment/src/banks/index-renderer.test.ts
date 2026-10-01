import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BankKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { PERSONAL_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { git } from "../../test/workspaces.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex, type BankRole } from "./bank-index.js";
import { renderTrail } from "./index-renderer.js";

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
