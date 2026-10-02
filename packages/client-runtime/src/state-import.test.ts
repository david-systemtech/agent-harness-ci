import { randomUUID } from "node:crypto";
import { StateImportFinishedPayload, type EventFrame } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { machinePointedAt } from "../../environment/src/state-import/source/folders.js";
import { writeSourceFolder } from "../../environment/test/source-folder.js";
import { grantReader, holds, useHarness } from "../test/harness.js";
import { adminCall } from "./status/actions.js";
import { clientLocalImportValues } from "./state-import.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

/** Real runtime responses over WebSocket, fixture source bytes and platform
 * grants: locality is an Environment identity, never an address or hostname.
 * GUI card tests observe the owning presentation store across restart. */
const harness = useHarness();
it("offers the real import's presentation only after an application with matching local grant proof", async () => {
  const dataFolder = writeSourceFolder(harness.tempDir(), { preferences: {
    theme: "dark", fontSize: 18, conversationWidth: "wide", showThinking: false, settingsSection: "agents",
  } });
  const t = await harness.environment({ stateImportSource: machinePointedAt({ dataFolder, home: harness.tempDir() }) });
  const watcher = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
  const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  await watcher.next((frame) => frame.type === "synchronized" && frame.subscription === subscription);
  const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(t) }));
  await runtime.start();
  const run = async (dryRun: boolean) => {
    const answer = await adminCall(() => runtime.requests.call(t.env.id, "stateImport.run", { commandId: randomUUID(), dryRun }));
    if (!answer.ok || answer.result === undefined) throw new Error("The fixture import did not answer a report.");
    return answer.result;
  };
  const preview = await run(true);
  expect(preview.clientLocal).toEqual({ mode: "dark", fontSize: 18, conversationWidth: "wide", showThinking: false, settingsRow: "knowledge.instructions" });
  expect(clientLocalImportValues(runtime, t.env.id, true, preview)).toBeNull();
  expect(clientLocalImportValues(runtime, t.env.id, false, preview)).toBeNull();
  expect(watcher.received.filter((frame) => frame.type === "event")).toEqual([]);
  const imported = await run(false);
  expect(clientLocalImportValues(runtime, t.env.id, false, imported)).toEqual(preview.clientLocal);
  expect(clientLocalImportValues(runtime, t.env.id, true, imported)).toBeNull();
  const finished = await watcher.next((frame): frame is EventFrame => frame.type === "event" && frame.subscription === subscription && frame.event.type === "state-import.finished");
  const shared = StateImportFinishedPayload.parse(imported);
  expect(finished.event.payload).toEqual(shared);
  expect(finished.event.actor).toEqual({ kind: "client_session", id: runtime.connections.list.read()[0]?.clientSessionId });
  expect(finished.event.payload).not.toHaveProperty("clientLocal");
  expect(finished.event.payload).not.toHaveProperty("dryRun");
});

it("refuses a late report when a newer desktop revokes the exchanged local session", async () => {
  const dataFolder = writeSourceFolder(harness.tempDir(), { preferences: { theme: "dark" } });
  const t = await harness.environment({ stateImportSource: machinePointedAt({ dataFolder, home: harness.tempDir() }) });
  const first = harness.runtime(inMemoryPlatform({ kind: "desktop", grant: grantReader(t) }));
  await first.start();
  const answer = await adminCall(() => first.requests.call(t.env.id, "stateImport.run", { commandId: randomUUID(), dryRun: false }));
  if (!answer.ok || answer.result === undefined) throw new Error("No import report.");
  const second = harness.runtime(inMemoryPlatform({ kind: "desktop", grant: grantReader(t) }));
  await second.start();
  await holds(first.connections.list, (list) => list[0]?.phase === "blocked");
  expect(first.local.read()).toEqual({ state: "exchanged", environmentId: t.env.id });
  expect(clientLocalImportValues(first, t.env.id, false, answer.result)).toBeNull();
});

it.each(["none", "stale", "other-environment"] as const)("reports paired import values as unapplied with %s grant proof, even on loopback with the same hostname", async (proof) => {
  const dataFolder = writeSourceFolder(harness.tempDir(), { preferences: { theme: "light" } });
  const t = await harness.environment({ hostname: "same-machine", stateImportSource: machinePointedAt({ dataFolder, home: harness.tempDir() }) });
  const { link } = await t.createPairing({ scopes: ["read", "admin"] });
  const other = proof === "other-environment" ? await harness.environment({ hostname: "same-machine" }) : undefined;
  const staleGrant = { ...t.grant(), secret: "token-for-tests" };
  const platform = inMemoryPlatform({ kind: "desktop", ...(proof !== "none" && {
    grant: other === undefined ? { read: async () => staleGrant } : grantReader(other),
  }) });
  if (proof === "stale") {
    const seeded = harness.runtime(inMemoryPlatform({ kind: "desktop", documents: platform.documents, secrets: platform.secrets }));
    await seeded.start();
    expect((await seeded.connections.add({ link })).status).toBe("paired");
    await seeded.close();
  }
  const runtime = harness.runtime(platform);
  await runtime.start();
  if (proof !== "stale") expect((await runtime.connections.add({ link })).status).toBe("paired");
  expect(runtime.connections.list.read().find((connection) => connection.environmentId === t.env.id)).toMatchObject({ kind: "paired", phase: "ready" });
  expect(runtime.local.read()).toMatchObject(proof === "none" ? { state: "none" } : proof === "stale" ? { state: "failed", reason: "refused" } : { state: "exchanged", environmentId: other?.env.id });
  const answer = await adminCall(() => runtime.requests.call(t.env.id, "stateImport.run", { commandId: randomUUID(), dryRun: false }));
  if (!answer.ok || answer.result === undefined) throw new Error("No paired import report.");
  expect(answer.result.clientLocal).toEqual({ mode: "light" });
  expect(clientLocalImportValues(runtime, t.env.id, false, answer.result)).toBeNull();
});
