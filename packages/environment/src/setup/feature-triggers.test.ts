import { randomUUID } from "node:crypto";
import { EnvironmentNotice, registry, type StepId, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { startFakeOpenBao } from "../../test/fake-openbao.js";
import { DAVID, TOKEN, added as addForge } from "../../test/forge.js";
import { PERSON_TOKEN, added as addKeyManager, token } from "../../test/key-manager-connections.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf } from "../../test/skill-repositories.js";
import type { WireClient } from "../../test/wire-client.js";

const { onCleanup, tempDir } = useCleanups();
const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};
const snapshot = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
  const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
  if (frame.type !== "snapshot") throw new Error("Expected the environment snapshot.");
  return registry["environment.subscribe"].result.parse(frame.payload).setup;
};
const observe = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  await client.next((f) => f.type === "synchronized" && f.subscription === subscription);
  return async (step: StepId): Promise<StepResult> => {
    const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "setup.result-changed" && f.event.payload["step"] === step);
    if (frame.type !== "event") throw new Error("Expected a result change.");
    const notice = EnvironmentNotice.parse(frame.event);
    if (notice.type !== "setup.result-changed") throw new Error("Expected a result change notice.");
    return notice.payload;
  };
};
const beforeWindow = async (t: TestEnvironment, client: WireClient, step: StepId) => {
  t.clock.advance(999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await snapshot(t, client))?.find((result) => result.step === step)?.checkedAt).toBe(MANUAL_CLOCK_START);
  t.clock.advance(1);
};
const CHECKED_AT = new Date(Date.parse(MANUAL_CLOCK_START) + 1_000).toISOString();

describe("the registered feature triggers", () => {
  it("checks Skills within a second of tracking a local bare repository and changes the snapshot without setup.check", async () => {
    const repositories = skillRepositories(tempDir);
    repositories.commit("david/triggers", { "skills/tdd/SKILL.md": skill("tdd") });
    const t = await start({ harnessGitConfig: skillsInsteadOf(repositories) });
    const client = await t.client();
    const changed = await observe(t, client);
    expect((await snapshot(t, client))?.find((result) => result.step === "skills")?.state).toBe("skipped");
    const answer = await client.request("skills.sources.add", {
      commandId: randomUUID(),
      url: `${SKILLS_HOST}david/triggers`,
      folder: "skills",
      follow: { kind: "branch", branch: null },
    });
    expect(answer.receipt.status).toBe("accepted");
    await beforeWindow(t, client, "skills");
    expect(await changed("skills")).toMatchObject({ state: "done", checkedAt: CHECKED_AT });
    expect((await snapshot(t, client))?.find((result) => result.step === "skills")).toMatchObject({ state: "done", checkedAt: CHECKED_AT });
  });

  it.each(["instructions", "account", "key-manager", "forge", "environment"] as const)("checks Instructions within a second of a real %s change, and publishes the changed orientation health", async (feature) => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    const bao = await startFakeOpenBao();
    onCleanup(() => bao.close());
    bao.token(PERSON_TOKEN, { policies: ["default"] });
    let unreadRegistries: string[] = [];
    let reads = 0;
    const t = await start({
      forgeFetch: forge.fetch,
      orientation: () => {
        reads += 1;
        return { text: "# Orientation", unreadRegistries };
      },
    });
    const client = await t.client();
    const changed = await observe(t, client);
    expect((await snapshot(t, client))?.find((result) => result.step === "instructions")?.state).toBe("done");
    unreadRegistries = ["banks"];
    if (feature === "instructions") {
      await client.request("instructions.create", { commandId: randomUUID(), id: randomUUID(), title: "My rules", body: "Use small modules." });
    } else if (feature === "account") {
      const { accounts } = await client.request("accounts.list", {});
      await client.request("accounts.relabel", { commandId: randomUUID(), accountId: accounts[0]!.id, label: "Work" });
    } else if (feature === "key-manager") {
      await addKeyManager(client, { address: bao.address, ca: bao.ca, credential: token() });
    } else if (feature === "forge") {
      await addForge(client, { url: forge.origin, kind: "forgejo" });
    } else {
      await client.request("environment.rename", { commandId: randomUUID(), name: "Work" });
    }
    const before = reads;
    await beforeWindow(t, client, "instructions");
    expect(await changed("instructions")).toMatchObject({ state: "needs-attention", failing: ["instructions.orientation-renders"], checkedAt: CHECKED_AT });
    expect(reads).toBe(before + 1);
    expect((await snapshot(t, client))?.find((result) => result.step === "instructions")).toMatchObject({ state: "needs-attention", checkedAt: CHECKED_AT });
  });

  it("turns a second client's Forges result from skipped to done a second after the first adds an account, without Check now", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    const t = await start({ forgeFetch: forge.fetch });
    const writer = await t.client();
    const reader = await t.client();
    const changed = await observe(t, reader);
    expect((await snapshot(t, reader))?.find((result) => result.step === "forges")?.state).toBe("skipped");
    await addForge(writer, { url: forge.origin, kind: "forgejo" });
    await beforeWindow(t, reader, "forges");
    expect(await changed("forges")).toMatchObject({ state: "done", checkedAt: CHECKED_AT });
    expect((await snapshot(t, reader))?.find((result) => result.step === "forges")).toMatchObject({ state: "done", checkedAt: CHECKED_AT });
  });

  it("checks Key manager within a second of adding an OpenBao connection and publishes its missing run access without setup.check", async () => {
    const bao = await startFakeOpenBao();
    onCleanup(() => bao.close());
    bao.token(PERSON_TOKEN, { policies: ["default"] });
    const t = await start();
    const client = await t.client();
    const changed = await observe(t, client);
    expect((await snapshot(t, client))?.find((result) => result.step === "key-manager")?.state).toBe("skipped");
    await addKeyManager(client, { address: bao.address, ca: bao.ca, credential: token() });
    await beforeWindow(t, client, "key-manager");
    expect(await changed("key-manager")).toMatchObject({ state: "needs-attention", checkedAt: CHECKED_AT });
    expect((await snapshot(t, client))?.find((result) => result.step === "key-manager")).toMatchObject({ state: "needs-attention", checkedAt: CHECKED_AT });
  });
});
