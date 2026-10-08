import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import { presetInjection } from "../adapter/process-environment.js";
import { noSkillSet } from "../adapter/seams.js";
import type { OrientationAnswer } from "./composer.js";

const { onCleanup } = useCleanups();
const check = async (client: WireClient) => (await client.request("setup.check", { step: "instructions" })).results[0];

it("checks the orientation seam and names every unread registry, including when the orientation switch is off", async () => {
  let unreadRegistries: string[] = [];
  const t = await startTestEnvironment({ orientation: () => ({ text: "# Orientation", unreadRegistries }) });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await check(client)).toMatchObject({ state: "done", failing: [], actions: [] });
  unreadRegistries = ["banks", "forges"];
  const failed = await check(client);
  expect(failed).toMatchObject({ state: "needs-attention", failing: ["instructions.orientation-renders"], actions: [] });
  expect(failed?.reason).toContain("banks");
  expect(failed?.reason).toContain("forges");
  await client.request("settings.update", { commandId: randomUUID(), values: { "instructions.orientation": false } });
  expect(await check(client)).toMatchObject({ state: "needs-attention", failing: ["instructions.orientation-renders"] });
  unreadRegistries = [];
  expect(await check(client)).toMatchObject({ state: "done", failing: [] });
});

it("never skips Instructions on an environment with no account", async () => {
  const t = await startTestEnvironment({ accounts: [] });
  onCleanup(() => t.close());
  expect(await check(await t.client())).toMatchObject({ state: "done", failing: [] });
});

it("answers within the local five-second budget when the orientation seam never settles", async () => {
  let held = false;
  let called = (): void => undefined;
  let answer: (value: OrientationAnswer) => void = () => undefined;
  const call = new Promise<void>((resolve) => { called = resolve; });
  const t = await startTestEnvironment({ orientation: () => {
    if (!held) return { text: "# Orientation", unreadRegistries: [] };
    called();
    return new Promise<OrientationAnswer>((resolve) => { answer = resolve; });
  } });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await check(client)).toMatchObject({ state: "done" });
  held = true;
  const checking = check(client);
  await call;
  t.clock.advance(5_000);
  expect(await checking).toMatchObject({ state: "needs-attention", failing: ["instructions.orientation-renders"], actions: ["check-again"], reason: "Checking took too long. Choose Check again." });
  answer({ text: "# Orientation", unreadRegistries: [] });
});

it("checks and previews orientation without resolving skills or deciding a provider process's injection", async () => {
  let injections = 0;
  let skillSets = 0;
  const t = await startTestEnvironment({ adapterSeams: {
    injection: (scope) => { injections += 1; return presetInjection(scope); },
    skillSet: (scope) => { skillSets += 1; return noSkillSet(scope); },
  } });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(await check(client)).toMatchObject({ state: "done" });
  await client.request("instructions.list", {});
  expect(injections).toBe(0);
  expect(skillSets).toBe(0);
});
