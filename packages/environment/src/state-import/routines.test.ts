import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { machinePointedAt } from "./source/folders.js";

const { tempDir, onCleanup } = useCleanups();
const write = (folder: string, file: string, value: unknown) => writeFileSync(join(folder, file), JSON.stringify(value));
const sourceRoutine = (cwd: string, fields: Record<string, unknown> = {}) => {
  const schedule: unknown = { kind: "weekly", day: 4, at: "08:05" };
  return ({ id: "daily", name: "Daily checks", instructions: "Read the checks.", cwd, profileId: "work", providerId: "claude", permissionMode: "bypassPermissions", schedule, paused: false, createdAt: 1, history: [{ firedAt: 1, outcome: "completed" }], ...fields });
};
const start = async (source: string, options: TestEnvironmentOptions = {}) => {
  const directory = tempDir();
  write(source, "profiles.json", { version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] });
  const adapter = { ...fakeAdapter({ provider: "claude", ambientDirectory: null, sessions: [], status: () => signedInAs("fixture@example.com") }), observeIdentity: async () => ({ provider: "claude", email: "fixture@example.com", organisation: null }) };
  const t = await startTestEnvironment({ adapter, accounts: [], setupSteps: NO_SETUP_STEPS, timeZone: "Asia/Manila", stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }), ...options });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

it("previews and imports both source stores disabled, preserves local schedules and zones, and never fires", async () => {
  const source = tempDir();
  const cwd = tempDir();
  write(source, "routines.json", { routines: [sourceRoutine(cwd)] });
  write(source, "serverRoutines.json", { routines: [sourceRoutine("/ignored-client-path", { id: "daily", name: "Service checks", scope: `dir:${cwd}`, connectionId: "source-connection", timezone: "Etc/UTC", paused: true, schedule: { kind: "cron", expression: "5 * * * *" } })] });
  const { t, client } = await start(source);
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result).toMatchObject({ carried: { routines: 2 }, failed: [], notCarried: [{ label: "Routine history", count: 2, step: null }] });
  expect((await client.request("routines.list", {})).routines).toEqual([]);
  const result = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(result.result).toEqual({ ...preview.result, dryRun: false });
  const { routines } = await client.request("routines.list", {});
  expect(routines.map(({ definition }) => definition)).toMatchObject([
    { enabled: false, schedule: { kind: "weekly", day: "thursday", at: "08:05" }, timezone: "Asia/Manila", workspace: { kind: "directory", path: cwd }, account: { provider: "claude", email: "fixture@example.com" } },
    { enabled: false, schedule: { kind: "cron", expression: "5 * * * *" }, timezone: "Etc/UTC", workspace: { kind: "directory", path: cwd } },
  ]);
  t.clock.advance(10 * 60_000);
  for (const routine of routines) expect((await client.request("routines.history", { routineId: routine.state.id })).entries).toEqual([]);
  expect(t.adapter.runs).toHaveLength(0);
});

it("fails invalid entries independently, reports omitted baselines and the reviewed watch, and retries without overwriting edits", async () => {
  const source = tempDir();
  const cwd = tempDir();
  const routines = [
    sourceRoutine(cwd),
    sourceRoutine(cwd, { id: "missing-account", name: "Missing Account", profileId: "absent" }),
    sourceRoutine(cwd, { id: "deferred", name: "Deferred Account", profileId: "deferred", providerId: "codex" }),
    sourceRoutine(join(cwd, "missing"), { id: "missing-workspace", name: "Missing Workspace" }),
    sourceRoutine(cwd, { id: "unsupported", name: "Fast cron", schedule: { kind: "cron", expression: "* * * * *" } }),
    sourceRoutine(cwd, { id: "watch", name: "Upstream watch", preCheckBaseline: "baseline-for-tests" }),
  ];
  write(source, "routines.json", { routines });
  writeFileSync(join(source, "serverRoutines.json"), "invalid JSON with token-for-tests");
  const { client } = await start(source);
  write(source, "profiles.json", { version: 2, profiles: [{ id: "deferred", label: "Deferred", providerId: "codex", configDir: cwd }, { id: "work", label: "Work", providerId: "claude", configDir: tempDir() }] });
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result?.carried.routines).toBe(1);
  expect(preview.result?.failed).toHaveLength(6);
  expect(preview.result?.notCarried).toContainEqual({ label: "Routine pre-check baselines", count: 1, step: null });
  expect(preview.result?.notCarried).toContainEqual({ label: "Upstream watches", count: 1, step: null });
  const commandId = randomUUID();
  const imported = await client.request("stateImport.run", { commandId, dryRun: false });
  expect(imported.result).toEqual({ ...preview.result, dryRun: false });
  const first = (await client.request("routines.list", {})).routines[0]!;
  await client.request("routines.update", { commandId: randomUUID(), routineId: first.state.id, fields: { instructions: "Harness edit.", schedule: { kind: "manual" } } });
  routines[0]!.instructions = "Source edit must not overwrite.";
  routines[3]!.cwd = cwd;
  routines[4]!.schedule = { kind: "cron", expression: "5 * * * *" };
  write(source, "routines.json", { routines });
  write(source, "serverRoutines.json", { routines: [sourceRoutine(cwd, { id: "service", name: "Service checks", scope: `dir:${cwd}`, connectionId: "discarded-connection" })] });
  await client.request("stateImport.run", { commandId, dryRun: false });
  expect((await client.request("routines.list", {})).routines).toHaveLength(1);
  const retried = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(retried.result).toMatchObject({ carried: { routines: 3 }, failed: expect.any(Array) });
  expect(retried.result?.failed).toHaveLength(2);
  expect((await client.request("routines.list", {})).routines.find((routine) => routine.state.id === first.state.id)?.definition).toMatchObject({ instructions: "Harness edit.", schedule: { kind: "manual" }, enabled: false });
  await client.request("routines.delete", { commandId: randomUUID(), routineId: first.state.id });
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result?.carried.routines).toBe(0);
  expect((await client.request("routines.list", {})).routines).toHaveLength(3);
});

it("keeps Routine mappings after a crash and restart without duplicating or re-enabling the committed child", async () => {
  const source = tempDir();
  const cwd = tempDir();
  write(source, "routines.json", { routines: [sourceRoutine(cwd), sourceRoutine(cwd, { id: "second", name: "Second checks" })] });
  const dataDir = tempDir();
  const crashed = await start(source, { dataDir, stateImportHooks: { carried: (item) => { if (item.kind === "routine") throw new Error("Fixture crash after Routine child commit."); } } });
  await expect(crashed.client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).rejects.toMatchObject({ code: "internal" });
  const before = (await crashed.client.request("routines.list", {})).routines[0]!;
  await crashed.t.close();
  const restarted = await start(source, { dataDir });
  const report = await restarted.client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(report.result).toMatchObject({ carried: { accounts: 0, routines: 1 }, failed: [] });
  const { routines } = await restarted.client.request("routines.list", {});
  expect(routines).toHaveLength(2);
  expect(routines[0]?.state.id).toBe(before.state.id);
  expect(routines.every((routine) => routine.definition.enabled === false)).toBe(true);
});

it("rejects changed Routine store bytes independently and does not infer a local Workspace from a saved Connection", async () => {
  const source = tempDir();
  const cwd = tempDir();
  write(source, "routines.json", { routines: [sourceRoutine(cwd)] });
  write(source, "serverRoutines.json", { routines: [sourceRoutine(cwd, { id: "service", scope: "conn:unresolved", connectionId: "unresolved" })] });
  const { client } = await start(source, { stateImportHooks: { planned: () => write(source, "routines.json", { routines: [] }) } });
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result).toMatchObject({ carried: { routines: 1 }, failed: [{ label: "Service Routines" }] });
  const imported = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(imported.result).toMatchObject({ carried: { accounts: 1, routines: 0 }, failed: [{ label: "Service Routines" }, { label: "Desktop Routines", message: "It changed after it was read: preview again, then import." }, { label: "Routine firings", message: "It changed after it was read: preview again, then import." }] });
  expect((await client.request("routines.list", {})).routines).toEqual([]);
});

it("reports duplicate names across stores as failures already in preview", async () => {
  const source = tempDir();
  const cwd = tempDir();
  write(source, "routines.json", { routines: [sourceRoutine(cwd)] });
  write(source, "serverRoutines.json", { routines: [sourceRoutine(cwd, { scope: `dir:${cwd}`, connectionId: "source-connection" })] });
  const { client } = await start(source);
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result).toMatchObject({ carried: { routines: 1 }, failed: [{ label: 'Routine "Daily checks"' }] });
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toEqual({ ...preview.result, dryRun: false });
});

it("refuses Routine children when a changed profile store prevents the planned Account mapping from committing", async () => {
  const source = tempDir();
  write(source, "routines.json", { routines: [sourceRoutine(tempDir())] });
  const { client } = await start(source, { stateImportHooks: { planned: () => write(source, "profiles.json", { version: 2, profiles: [] }) } });
  const answer = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(answer.result).toMatchObject({ carried: { accounts: 0, routines: 0 }, failed: [{ label: "Accounts" }, { label: 'Routine "Daily checks"', message: "Its Account mapping is not live; retry after repairing it." }] });
  expect((await client.request("routines.list", {})).routines).toEqual([]);
});

it("deduplicates both upstream-watch copies against the reviewed document even when their source configuration cannot be converted", async () => {
  const source = tempDir();
  write(source, "routines.json", { routines: [{ name: "Upstream watch", schedule: { kind: "unsupported" } }] });
  write(source, "serverRoutines.json", { routines: [{ name: "upstream watch", profileId: "retired", connectionId: "discarded" }] });
  const { client } = await start(source);
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result).toMatchObject({ carried: { routines: 0 }, failed: [], notCarried: [{ label: "Upstream watches", count: 2, step: null }] });
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toEqual({ ...preview.result, dryRun: false });
  expect((await client.request("routines.list", {})).routines).toEqual([]);
});

it("reads the service store when desktop JSON is malformed, and refuses unsupported zones without guessing", async () => {
  const source = tempDir();
  const cwd = tempDir();
  writeFileSync(join(source, "routines.json"), "malformed JSON with token-for-tests");
  write(source, "serverRoutines.json", { routines: [sourceRoutine(cwd, { scope: `dir:${cwd}`, connectionId: "ignored-connection" }), sourceRoutine(cwd, { id: "bad-zone", name: "Bad zone", scope: `dir:${cwd}`, connectionId: "ignored-connection", timezone: "unsupported-for-tests" })] });
  const { client } = await start(source);
  const preview = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
  expect(preview.result).toMatchObject({ carried: { routines: 1 }, failed: [{ label: "Desktop Routines" }, { label: "Service Routines" }, { label: "Routine firings" }] });
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toEqual({ ...preview.result, dryRun: false });
  expect((await client.request("routines.list", {})).routines).toHaveLength(1);
});


it("rechecks pinned Workspace usability before the Routine child commits and retries it after repair", async () => {
  const source = tempDir();
  const cwd = tempDir();
  write(source, "routines.json", { routines: [sourceRoutine(cwd)] });
  const { client } = await start(source, { stateImportHooks: { planned: () => rmSync(cwd, { recursive: true, force: true }) } });
  const imported = await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
  expect(imported.result).toMatchObject({ carried: { accounts: 1, routines: 0 }, failed: [{ label: 'Routine "Daily checks"' }] });
  expect((await client.request("routines.list", {})).routines).toEqual([]);
  write(source, "routines.json", { routines: [sourceRoutine(tempDir())] });
  expect((await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).result).toMatchObject({ carried: { accounts: 0, routines: 1 }, failed: [] });
});
