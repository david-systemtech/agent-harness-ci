import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENVIRONMENT_STREAM_KIND, registry, type BankRecord, type EventFrame, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { changed, PERSONAL_BANK, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

/**
 * The orientation block's banks section (banks spec, "The Memory bank step
 * and the orientation block"; key-managers spec, "The orientation block";
 * #1025) through the primary seam: banks registered through
 * `banks.register` and the instructions a run is given. Each bank in the
 * run's scope is named with its kind, its role and whether landing works,
 * as a status with when it began, never a time the clock gives.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  return t;
};

/** A git repository at a folder named `name` holding `files` in one commit on main. */
const gitBank = (files: Readonly<Record<string, string>>, name: string): string => {
  const root = join(tempDir("agent-harness-bank-"), name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

const register = async (client: WireClient, path: string, params: Partial<Omit<ParamsOf<"banks.register">, "commandId" | "path">> = {}): Promise<BankRecord> => {
  const answer: ResponseOf<"banks.register"> = await client.request("banks.register", {
    commandId: randomUUID(),
    bankId: randomUUID(),
    path,
    role: "read-write",
    accounts: "all",
    repositories: "all",
    defaultFor: [],
    ...params,
  });
  if (answer.result === undefined) throw new Error(`banks.register was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.bank;
};

/** The instructions the session's next run is given, once that run has ended. */
const runInstructions = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<string> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: t.env.log.head() });
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Fix the receipts" }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
  return t.adapter.lastRun().input.instructions;
};

const HEADING = "The memory banks this run reads, each with its kind and role, and whether landing on it works:";

describe("the banks section", () => {
  it("names each bank in the run's scope with its kind, role and landing status since it began, from state alone", async () => {
    const t = await start();
    const client = await t.client();
    await register(client, gitBank(PERSONAL_BANK, "maya-memory"));
    const team = await register(client, gitBank(TEAM_BANK, "acme"), { role: "read-only" });
    await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": null }), "david-memory"), { repositories: ["https://git.example/acme/web"] });
    await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": null }), "sam-memory"), { accounts: [randomUUID()] });
    t.clock.advance(5 * 60_000);
    t.env.log.atomically((tx) =>
      t.env.log.append(
        { kind: ENVIRONMENT_STREAM_KIND, id: t.env.id },
        [{ type: "bank.landing-failed", payload: { bankId: team.id, sessionId: null, step: "push", reason: "The forge refused the push." } }],
        { tx, actor: "system:banks" },
      ),
    );
    const session = await create(client);

    const text = await runInstructions(t, client, session.id);

    expect(text).toContain(
      [
        "## Memory banks",
        "",
        HEADING,
        "- maya-memory (personal, read-write): landing works, unchanged since 2026-09-24 00:00 UTC.",
        "- acme (team, read-only): landing failed at its push step since 2026-09-24 00:05 UTC. The forge refused the push.",
      ].join("\n"),
    );
    expect(text).not.toContain("david-memory");
    expect(text).not.toContain("sam-memory");
    t.clock.advance(60 * 60_000);
    expect(await runInstructions(t, client, session.id)).toBe(text);
  });

  it("is left out of the block when no bank is in the run's scope", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);
    expect(await runInstructions(t, client, session.id)).not.toContain("Memory banks");
  });
});
