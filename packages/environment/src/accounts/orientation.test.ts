import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, workspace } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * The orientation block's accounts section (David's decision on #381,
 * 2026-09-28: the claude-adapter spec's owed "account status in the
 * orientation block") through the primary seam: an in-process environment
 * holding two accounts on the scripted fake adapter, whose status probe a
 * test scripts, and the manual clock. What is asserted is the text a run
 * is handed and which process serves it.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }, { id: "work", provider: "fake" }], ...options });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session, waits for its end, and answers the instructions it was handed. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1), { timeout: WAIT_MS });
  return t.adapter.lastRun().input.instructions;
};

/** The accounts section's paragraphs, from its heading to the next section's. */
const accountsOf = (text: string): string[] => {
  const start = text.indexOf("## Accounts\n\n");
  if (start === -1) throw new Error(`No accounts section in:\n${text}`);
  const rest = text.slice(start + "## Accounts\n\n".length);
  const next = rest.indexOf("\n\n## ");
  return (next === -1 ? rest : rest.slice(0, next)).split("\n\n");
};

const MINUTE = 60_000;

const HEADING = "Accounts on this environment; a session can be handed to another only while it is signed in:";

describe("the accounts section", () => {
  it("is second in the block, one line per account with its label, whether it is signed in or expired and since when, this run's marked; a changed status gives the next run a fresh process", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);
    const first = await runTo(t, client, session.id);

    t.clock.advance(7 * MINUTE);
    t.adapter.setStatus((account) => (account.id === "work" ? { ...signedInAs(null), expired: true } : signedInAs(`${account.id}@example.com`)));
    const refreshed = await client.request("accounts.refresh", { accountId: "work" });
    expect(refreshed.accounts.find((account) => account.id === "work")?.status.state).toBe("expired");
    const second = await runTo(t, client, session.id, "After the expiry");

    expect(first.match(/^## .+$/gm)?.slice(0, 3)).toEqual(["## This environment", "## Accounts", "## Key managers"]);
    expect(accountsOf(first)).toEqual([`${HEADING}\n- claude-max, this run's: signed in since 2026-09-24 00:00 UTC.\n- work: signed in since 2026-09-24 00:00 UTC.`]);
    expect(accountsOf(second)).toEqual([`${HEADING}\n- claude-max, this run's: signed in since 2026-09-24 00:00 UTC.\n- work: expired since 2026-09-24 00:07 UTC.`]);
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([first, second]);
  });

  it("is byte-identical across status reads that find nothing new, never naming when one ran, so the session's process is reused", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);
    const first = await runTo(t, client, session.id);

    t.clock.advance(16 * MINUTE);
    await client.request("accounts.refresh", {});
    const second = await runTo(t, client, session.id, "After the reads");

    expect(second).toBe(first);
    expect(accountsOf(second).join("\n")).not.toContain("00:16");
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
  });

  it("names signed out and unreadable accounts with since when, and marks the account a preview's run would use", async () => {
    const t = await start();
    const client = await t.client();
    t.clock.advance(3 * MINUTE);
    t.adapter.setStatus((account) => (account.id === "work" ? signedInAs(null) : { ...signedInAs(null), error: "The binary could not be run." }));
    await client.request("accounts.refresh", {});

    const preview = await client.request("instructions.preview", { accountId: "work", workspace });

    expect(accountsOf(preview.text)).toEqual([`${HEADING}\n- claude-max: its status unreadable since 2026-09-24 00:03 UTC.\n- work, this run's: signed out since 2026-09-24 00:03 UTC.`]);
  });
});
