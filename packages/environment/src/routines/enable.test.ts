import { randomUUID } from "node:crypto";
import { MODES, RoutineDefinitionInput, type RoutineDefinition, type RoutineDefinitionInput as WrittenDefinition } from "@agent-harness/contracts";
import { renderRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { written } from "../../test/routines.js";

const { onCleanup } = useCleanups();
const yamlOf = (fields: Partial<WrittenDefinition> = {}) => {
  const definition: RoutineDefinition = { ...RoutineDefinitionInput.parse(written({ enabled: false, timezone: "Etc/UTC", ...fields })), timezone: "Etc/UTC" };
  return renderRoutineYaml([definition], { environmentName: "Fixture", exportedAt: "2026-01-01T00:00:00.000Z" });
};

it.each([
  { fields: { account: { provider: "fake", email: "absent@example.com", organisation: null } }, attention: "account_missing" },
  { fields: { model: "unavailable-model" }, attention: "model_unavailable" },
  { fields: { skills: ["unavailable-skill"] }, attention: "skill_unknown" },
  { fields: { preCheck: { kind: "script", path: "unavailable.sh" } }, attention: "script_missing" },
  { fields: { delivery: [{ kind: "webhook", target: "missing-endpoint", on: "both" }] }, attention: "endpoint_missing" },
] satisfies { fields: Partial<WrittenDefinition>; attention: string }[])("refuses manual enable for $attention without running the imported Routine", async ({ fields, attention }) => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const routineId = randomUUID();
  expect((await client.request("routines.import", { commandId: randomUUID(), routineIds: [routineId], yaml: yamlOf(fields) })).receipt.status).toBe("accepted");
  const enable = await client.request("routines.enable", { commandId: randomUUID(), routineId });
  expect(enable.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "enable_conditions", attention: [attention] } } });
  expect((await client.request("routines.list", {})).routines[0]?.definition.enabled).toBe(false);
  t.clock.advance(60_000);
  expect(t.adapter.runs).toHaveLength(0);
});

it("revalidates signed-out Accounts on enable", async () => {
  const t = await startTestEnvironment({ adapter: fakeAdapter({ status: () => signedInAs(null) }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const routineId = randomUUID();
  await client.request("routines.import", { commandId: randomUUID(), routineIds: [routineId], yaml: yamlOf() });
  expect((await client.request("routines.enable", { commandId: randomUUID(), routineId })).receipt).toMatchObject({ status: "rejected", error: { data: { attention: ["account_signed_out"] } } });
});

it("uses the actual caller Ceiling and current permissions, then enables only after a deliberate repair", async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const routineId = randomUUID();
  await client.request("routines.import", { commandId: randomUUID(), routineIds: [routineId], yaml: yamlOf({ mode: "bypassPermissions" }) });
  const constrained = await t.client({ token: (await t.pair({ ceiling: "acceptEdits" })).token });
  const refused = await constrained.request("routines.enable", { commandId: randomUUID(), routineId });
  expect(refused.receipt).toMatchObject({ status: "rejected", error: { data: { attention: ["clamped"] } } });
  expect((await client.request("routines.list", {})).routines[0]).toMatchObject({ definition: { enabled: false }, state: { savedUnderCeiling: "bypassPermissions" } });
  await constrained.request("routines.update", { commandId: randomUUID(), routineId, fields: { mode: "acceptEdits" } });
  const enabled = await constrained.request("routines.enable", { commandId: randomUUID(), routineId });
  expect(enabled.result?.routine).toMatchObject({ definition: { enabled: true }, state: { savedUnderCeiling: "acceptEdits", savedBy: constrained.hello.clientSessionId } });
});

it("revalidates Account permission availability even when the Routine inherits its mode", async () => {
  const t = await startTestEnvironment({ adapter: fakeAdapter({ modes: MODES.map((mode) => ({ mode, available: false, reason: "unavailable-for-tests" })) }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const routineId = randomUUID();
  await client.request("routines.import", { commandId: randomUUID(), routineIds: [routineId], yaml: yamlOf() });
  expect((await client.request("routines.enable", { commandId: randomUUID(), routineId })).receipt).toMatchObject({ status: "rejected", error: { data: { attention: ["clamped"] } } });
});

it.each(["edit", "document replacement"])("keeps the enable gate when an %s tries to turn a disabled Routine on", async (through) => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const routineId = randomUUID();
  const account = { provider: "fake", email: "absent@example.com", organisation: null };
  await client.request("routines.import", { commandId: randomUUID(), routineIds: [routineId], yaml: yamlOf({ account }) });
  const result = through === "edit"
    ? await client.request("routines.update", { commandId: randomUUID(), routineId, fields: { enabled: true } })
    : await client.request("routines.import", { commandId: randomUUID(), routineId, yaml: yamlOf({ account, enabled: true }) });
  expect(result.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "enable_conditions", attention: ["account_missing"] } } });
  expect((await client.request("routines.list", {})).routines[0]?.definition.enabled).toBe(false);
});

it("requires a delivery secret and rechecks the repaired endpoint without posting or firing", async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const routineId = randomUUID();
  const endpoint = { name: "alerts", url: "https://alerts.example.com/hook" };
  await client.request("routines.endpoints.set", { commandId: randomUUID(), ...endpoint });
  await client.request("routines.import", { commandId: randomUUID(), routineIds: [routineId], yaml: yamlOf({ delivery: [{ kind: "webhook", target: "alerts", on: "both" }] }) });
  expect((await client.request("routines.enable", { commandId: randomUUID(), routineId })).receipt).toMatchObject({ status: "rejected", error: { data: { attention: ["endpoint_needs_secret"] } } });
  await client.request("routines.endpoints.set", { commandId: randomUUID(), ...endpoint, secret: { kind: "pasted", secret: "delivery-secret-for-tests" } });
  expect((await client.request("routines.enable", { commandId: randomUUID(), routineId })).result?.routine.definition.enabled).toBe(true);
  expect((await client.request("routines.history", { routineId })).entries).toEqual([]);
  expect(t.adapter.runs).toHaveLength(0);
});
