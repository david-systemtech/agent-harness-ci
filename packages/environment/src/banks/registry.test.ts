import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BankRecord, ParamsOf, ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { PERSONAL_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

/**
 * The BankRegistry and the BankService's register, list, get and verify
 * (banks spec, "The registry" and "The BankService's methods"; #1025)
 * through the primary seam: an in-process environment and a real client,
 * fixture banks as git repositories on disk. What is asserted is what the
 * bank methods answer a client and the events the environment stream
 * carries.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A git repository holding `files` in one commit on main. */
const gitBank = (files: Readonly<Record<string, string>>): string => {
  const root = tempDir("agent-harness-bank-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

type RegisterParams = Omit<ParamsOf<"banks.register">, "commandId" | "bankId" | "role" | "accounts" | "repositories" | "defaultFor"> &
  Partial<Pick<ParamsOf<"banks.register">, "bankId" | "role" | "accounts" | "repositories" | "defaultFor">>;

/** Sends `banks.register` with a fresh command id and bank id unless given, read-write in every scope unless said. */
const register = (client: WireClient, params: RegisterParams): Promise<ResponseOf<"banks.register">> =>
  client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...params });

/** The bank a register made; throws unless it was accepted. */
const registered = async (client: WireClient, params: RegisterParams): Promise<BankRecord> => {
  const answer = await register(client, params);
  if (answer.result === undefined) throw new Error(`banks.register was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.bank;
};

const list = async (client: WireClient): Promise<BankRecord[]> => (await client.request("banks.list", {})).banks;

const PERSONAL_LINE = "## maya-memory (personal, read-write) — 5 memories in 3 folders — Maya Reyes's private memory: her machines, projects and companies. Team facts go to the team's own bank.";

describe("banks.register and banks.list", () => {
  it("registers a local checkout by its path, keeping it, and lists it with its settings, status, counts and bank line", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = gitBank(PERSONAL_BANK);
    const bankId = randomUUID();

    const bank = await registered(client, { bankId, path: checkout });

    const since = MANUAL_CLOCK_START;
    expect(bank).toEqual({
      id: bankId,
      name: "maya-memory",
      kind: "personal",
      location: { kind: "local" },
      checkout,
      role: "read-write",
      enabled: true,
      accounts: "all",
      repositories: "all",
      defaultFor: [],
      pins: [],
      mergeOverride: "none",
      privateCopy: false,
      credential: "forge",
      status: {
        reachable: { state: "reachable", since },
        manifest: { state: "valid", since },
        orientation: { missing: [], since },
        owners: { unresolved: [], since },
        lastSync: null,
        landing: { state: "ok", since },
      },
      importedFrom: null,
      copiedFrom: null,
      createdAt: since,
      memories: 5,
      folders: 3,
      line: PERSONAL_LINE,
    });
    expect(await list(client)).toEqual([bank]);
  });
});
