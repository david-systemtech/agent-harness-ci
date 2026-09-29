import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, pasted, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The orientation block's forges section (forge spec, "Orientation";
 * key-managers spec, "The orientation block"; ADR 0012, ADR 0020; #318)
 * through the primary seam: an in-process environment whose git names a
 * stand-in as its credential helper, the fake forge answering its API, the
 * scripted fake adapter reporting the instructions each run was handed and
 * each process was spawned with, and the manual clock. What is asserted is
 * the text a run is handed and which process serves it.
 */

const { onCleanup } = useCleanups();

/** The command git would name as its helper: never run here. */
const HELPER = ["/opt/agent-harness/bin/agent-harness"];

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

const start = async (forge: FakeForge, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: HELPER, ...options });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session, waits for its end, and answers the instructions it was handed. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
  return t.adapter.lastRun().input.instructions;
};

const MINUTE = 60_000;

/** The fake forge's origin as the section names it: its host and port. */
const hostOf = (forge: FakeForge): string => forge.origin.replace(/^https?:\/\//, "");

describe("the forges section", () => {
  it("names each forge account on one line with its slug, kind, login and status since that status last changed", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text).toContain(
      [
        `- home: ${hostOf(forge)} (Forgejo), login david: verified, unchanged since 2026-09-24 00:00 UTC.`,
        "- github: GitHub, login david: verified, unchanged since 2026-09-24 00:00 UTC.",
      ].join("\n"),
    );
  });

  it("is byte-identical across verifications that find nothing new, never naming when one ran, so the session's process is reused", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const first = await runTo(t, client, session.id);
    const identityReads = () => forge.requests.filter((request) => request.path === "/api/v1/user").length;
    const readsBefore = identityReads();

    // The scheduled verification at 00:15, then one asked for at 00:20: neither finds anything new.
    t.clock.advance(16 * MINUTE);
    await vi.waitFor(() => expect(identityReads()).toBe(readsBefore + 1));
    t.clock.advance(4 * MINUTE);
    await verify(client);
    const second = await runTo(t, client, session.id, "After the verifications");

    expect(second).toBe(first);
    expect(second).toContain("verified, unchanged since 2026-09-24 00:00 UTC.");
    expect(second).not.toMatch(/00:1[56]|00:20/);
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
  });

  it("states a problem with when it began, and the session's next run gets a fresh process spawned with the new text", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const before = await runTo(t, client, session.id);

    t.clock.advance(7 * MINUTE);
    forge.answer(TOKEN, "GET /api/v1/user", { status: 401, body: { message: "token is required" } });
    await verify(client);
    const after = await runTo(t, client, session.id, "After the rejection");

    expect(after).not.toBe(before);
    expect(after).toContain(
      `- home: ${hostOf(forge)} (Forgejo), login david: credential rejected since 2026-09-24 00:07 UTC. The forge at ${forge.origin} refused the token (HTTP 401).`,
    );
    const processes = t.adapter.processesOf(session.id);
    expect(processes).toHaveLength(2);
    expect(processes.map((process) => process.instructions)).toEqual([before, after]);
  });
});
