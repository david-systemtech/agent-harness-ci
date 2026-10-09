import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeChrome, type FakeConnection } from "../../test/fake-extension.js";
import { startTestEnvironment } from "../../test/helper.js";

/** Browser health through setup.check, with the real listener and projection and a fake extension. */
const { onCleanup } = useCleanups();

const start = async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  const client = await t.client();
  onCleanup(() => client.close());
  const check = async () => (await client.request("setup.check", { step: "browser" })).results[0];
  const cached = async () => {
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    if (frame.type !== "snapshot") throw new Error("Expected the environment snapshot.");
    return registry["environment.subscribe"].result.parse(frame.payload).setup?.find((result) => result.step === "browser");
  };
  const advance = async (ms: number) => {
    t.clock.advance(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const chrome = () => fakeChrome(join(t.dataDir, "extension", "current"));
  const keep = (connection: FakeConnection) => {
    onCleanup(() => connection.extension.close());
    return connection;
  };
  const pair = async (name = "Work") => {
    const fake = chrome();
    const { code } = await client.apply("browser.pairing.code", {});
    const connection = keep(await fake.pair(code, name));
    expect(connection.answer.type).toBe("paired");
    return { fake, connection };
  };
  return { ...t, client, check, cached, advance, chrome, pair, keep };
};

describe("the Browser step (#559; setup-copy.md §5.11, #1857)", () => {
  it("skips with nothing paired, even while an unpaired extension is connected", async () => {
    const t = await start();
    expect(await t.check()).toMatchObject({ state: "skipped", reason: "Chrome is not connected. Optional.", failing: [], actions: [] });
    t.keep(await t.chrome().connect());
    expect(await t.check()).toMatchObject({ state: "skipped", failing: [], actions: [] });
  });

  it("is done while a paired Chrome is connected on the shipped version, and after it disconnects says Chrome is closed without offering Unpair as the fix", async () => {
    const t = await start();
    const { fake, connection } = await t.pair();
    expect(await t.check()).toMatchObject({ state: "done", failing: [], actions: [] });
    const { subscription } = await t.client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await connection.extension.close();
    await t.client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "chrome.updated" && f.event.payload.change === "disconnected");
    const closed = await t.check();
    expect(closed).toMatchObject({
      state: "needs-attention",
      failing: ["browser.chrome-connected"],
      reason: "Chrome is closed, so agents cannot use it. Open Chrome. This updates by itself.",
      actions: ["check-again"],
    });
    expect(closed).not.toHaveProperty("targets");
    t.keep(await fake.connect());
    expect(await t.check()).toMatchObject({ state: "done", failing: [] });
  });

  it("says the extension is out of date, each Chrome's version in details, including a disconnected one, and keeps its pairing", async () => {
    const t = await start();
    const { fake, connection } = await t.pair("Personal");
    await connection.extension.close();
    const older = t.keep(await fake.connect({ extensionVersion: "0.9.0-test" }));
    expect(await t.check()).toMatchObject({
      state: "needs-attention",
      failing: ["browser.extension-current"],
      reason: "The Chrome extension is out of date. In chrome://extensions, choose reload on agent-harness.",
      details: ["Personal: extension 0.9.0-test, this computer ships 1.0.0-test"],
      actions: ["reload", "check-again"],
      targets: [{ action: "reload", kind: "chrome", id: fake.credential()?.chromeId, label: "Personal" }],
    });
    await older.extension.close();
    await t.pair("Work");
    expect(await t.check()).toMatchObject({ state: "needs-attention", failing: ["browser.extension-current"] });
    expect((await t.client.apply("browser.chromes.list", {})).chromes.map((chrome) => chrome.name)).toEqual(["Personal", "Work"]);
    t.keep(await fake.connect());
    expect(await t.check()).toMatchObject({ state: "done", failing: [] });
  });

  it("rechecks on extension.seen within one second, with no setup.check request", async () => {
    const t = await start();
    await t.advance(60_000);
    const before = await t.cached();
    t.keep(await t.chrome().connect());
    await t.advance(999);
    expect((await t.cached())?.checkedAt).toBe(before?.checkedAt);
    await t.advance(1);
    expect(await t.cached()).toMatchObject({ state: "skipped", checkedAt: t.clock.now().toISOString() });
  });

  it("rechecks on chrome.updated within one second, from paired to disconnected to unpaired without setup.check requests", async () => {
    const t = await start();
    await t.advance(60_000);
    const { fake, connection } = await t.pair();
    await t.advance(1_000);
    expect(await t.cached()).toMatchObject({ state: "done", checkedAt: t.clock.now().toISOString() });
    const { subscription } = await t.client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await connection.extension.close();
    await t.client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "chrome.updated" && f.event.payload.change === "disconnected");
    await t.advance(1_000);
    expect(await t.cached()).toMatchObject({ state: "needs-attention", failing: ["browser.chrome-connected"], checkedAt: t.clock.now().toISOString() });
    const chromeId = fake.credential()?.chromeId;
    if (chromeId === undefined) throw new Error("Expected a paired Chrome.");
    await t.client.apply("browser.chromes.unpair", { commandId: randomUUID(), chromeId });
    await t.advance(1_000);
    expect(await t.cached()).toMatchObject({ state: "skipped", checkedAt: t.clock.now().toISOString() });
  });
});
