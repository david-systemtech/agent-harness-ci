import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Ceiling,
  DISCOVERY_PATH,
  DiscoveryDocument,
  ENVIRONMENT_COLOURS,
  EnvironmentNotice,
  type EnvironmentLook,
  type EventFrame,
  type Scope,
  type SnapshotFrame,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";
import type { Address } from "../serve/http.js";

/**
 * An environment's name, icon and colour through the primary seam
 * (workspace-picker spec, "Name, icon and colour"; #323): an in-process
 * environment whose hostname, platform and container detector are scripted
 * through its start options, driven by a real client. What is asserted is
 * what a client sees: discovery, `hello`, `environment.subscribe`'s
 * snapshot and notices, the three commands' receipts and results, and
 * `setup.check`'s line.
 */

const { onCleanup, tempDir } = useCleanups();

/** Preset: a Linux machine named `lab.tail1234.ts.net`, not a container. */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ hostname: "lab.tail1234.ts.net", platform: "linux", ...options });
  onCleanup(() => t.close());
  return t;
};

const discovery = async (address: Address): Promise<DiscoveryDocument> =>
  DiscoveryDocument.parse(await (await fetch(`http://${address.host}:${address.port}${DISCOVERY_PATH}`)).json());

/** What discovery says of the environment's look. */
const discoveredLook = async (address: Address) => {
  const { environmentName: name, environmentIcon: icon, environmentColour: colour } = await discovery(address);
  return { name, icon, colour };
};

/** What a new client's `hello` says of the environment's look. */
const helloLook = async (t: TestEnvironment) => {
  const { environmentName: name, environmentIcon: icon, environmentColour: colour } = (await t.client()).hello;
  return { name, icon, colour };
};

/** A client session issued straight from the environment, holding only `scopes`. */
const scopedClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a scoped program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

/** An environment record written before the first start, as an environment made before #323 left it. */
const existingRecord = (id: string, name: string): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "environment.json"), `${JSON.stringify({ id, createdAt: MANUAL_CLOCK_START, name }, null, 2)}\n`, { mode: 0o600 });
  return dataDir;
};

describe("an environment's look before anyone sets it", () => {
  it("names a new environment for its hostname's first label, and gives it the server icon on Linux and a colour of the twelve", async () => {
    const t = await start();
    const look = await discoveredLook(t.address);
    expect(look).toMatchObject({ name: "lab", icon: "server" });
    expect(ENVIRONMENT_COLOURS).toContain(look.colour);
    expect(await helloLook(t)).toEqual(look);
    expect(JSON.parse(readFileSync(join(t.dataDir, "environment.json"), "utf8"))).toMatchObject({ name: "lab" });
  });

  it("takes a hostname with no domain whole", async () => {
    const t = await start({ hostname: "SAMPLE-SERVER" });
    expect((await discoveredLook(t.address)).name).toBe("SAMPLE-SERVER");
  });

  it("keeps an existing record's own name, whatever the hostname", async () => {
    const t = await start({ dataDir: existingRecord(randomUUID(), "David's desk") });
    expect((await discoveredLook(t.address)).name).toBe("David's desk");
  });

  it("gives the icon of the platform: a laptop on macOS, a desktop on Windows, a server on Linux, and a container in a container whatever the platform", async () => {
    const icons: [TestEnvironmentOptions, string][] = [
      [{ platform: "darwin" }, "laptop"],
      [{ platform: "win32" }, "desktop"],
      [{ platform: "linux" }, "server"],
      [{ platform: "darwin", containerDetector: { inContainer: () => true } }, "container"],
      [{ platform: "linux", containerDetector: { inContainer: () => true } }, "container"],
    ];
    for (const [options, icon] of icons) {
      const t = await start(options);
      expect((await discoveredLook(t.address)).icon, JSON.stringify(options.platform)).toBe(icon);
    }
  });

  it("gives the colour by a hash of the environment's id: the same on every start, and not the same for every id", async () => {
    const id = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
    const dataDir = existingRecord(id, "desk");
    const first = await startTestEnvironment({ dataDir, platform: "linux" });
    const colour = (await discoveredLook(first.address)).colour;
    await first.close();
    const second = await start({ dataDir });
    expect((await discoveredLook(second.address)).colour).toBe(colour);
    // A hash that never changes between versions either: the SHA-256 of this id begins 4f3d4773 (computed apart, in Python), and 0x4f3d4773 mod 12 is 11, the twelfth colour.
    expect(colour).toBe("pink");

    const colours = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const t = await start({ dataDir: existingRecord(randomUUID(), `desk ${i}`) });
      colours.add((await discoveredLook(t.address)).colour ?? "none");
    }
    expect(colours.size).toBeGreaterThan(1);
  });

  it("answers environment.subscribe's snapshot with the look beside the status and Set up's results", async () => {
    const t = await start({ platform: "win32" });
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const snapshot = await client.next((f): f is SnapshotFrame => f.type === "snapshot" && f.subscription === subscription);
    expect(snapshot.payload).toEqual({
      status: expect.objectContaining({ readiness: "ready" }) as unknown,
      environment: { name: "lab", icon: "desktop", colour: (await discoveredLook(t.address)).colour },
      setup: expect.any(Array) as unknown,
    });
  });

  it("holds the Your machines step's named check from the first start", async () => {
    const t = await start();
    const client = await t.client();
    expect((await client.request("setup.check", { step: "your-machines" })).results[0]?.failing).not.toContain("your-machines.named");
    // With auto-update off the release channel's check holds unread, so the step is done, its line what was found (#1698).
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.autoUpdate": false } });
    const [result] = (await client.request("setup.check", { step: "your-machines" })).results;
    expect(result).toMatchObject({ state: "done", failing: [] });
    expect(result?.reason).toMatch(/^.+ is ready\. Automatic updates are off\.$/);
    expect(result?.details).toEqual(expect.arrayContaining(["Updates: off", "Reachable from: this computer only"]));
  });
});

describe("environment.rename, environment.setIcon and environment.setColour", () => {
  it("each append its notice on the environment stream with the command's id and actor, and answer the look as it now is", async () => {
    const t = await start();
    const client = await t.client();
    const { colour } = await discoveredLook(t.address);
    const head = t.env.log.head();
    const [renaming, icon, colouring] = [randomUUID(), randomUUID(), randomUUID()];

    expect(await client.request("environment.rename", { commandId: renaming, name: "  LAB \t box " })).toEqual({
      receipt: { status: "accepted", sequence: head + 1, changed: true },
      result: { name: "LAB box", icon: "server", colour },
    });
    expect(await client.request("environment.setIcon", { commandId: icon, icon: "nas" })).toEqual({
      receipt: { status: "accepted", sequence: head + 2, changed: true },
      result: { name: "LAB box", icon: "nas", colour },
    });
    const other = colour === "amber" ? "pink" : "amber";
    expect(await client.request("environment.setColour", { commandId: colouring, colour: other })).toEqual({
      receipt: { status: "accepted", sequence: head + 3, changed: true },
      result: { name: "LAB box", icon: "nas", colour: other },
    });

    const events = t.env.log.readStream({ kinds: ["environment"] }, head);
    expect(events.map((event) => [event.type, event.payload, event.commandId, event.streamId])).toEqual([
      ["environment.renamed", { name: "LAB box" }, renaming, t.env.id],
      ["environment.icon-set", { icon: "nas" }, icon, t.env.id],
      ["environment.colour-set", { colour: other }, colouring, t.env.id],
    ]);
    for (const event of events) expect(event.actor).toBe(`client_session:${client.hello.clientSessionId}`);
  });

  it("accept a value already held changed false, appending nothing", async () => {
    const t = await start();
    const client = await t.client();
    const held = await discoveredLook(t.address);
    const head = t.env.log.head();
    const look = { name: "lab", icon: "server", colour: held.colour };
    const unchanged = { receipt: { status: "accepted", sequence: head, changed: false }, result: look };
    expect(await client.request("environment.rename", { commandId: randomUUID(), name: " lab " })).toEqual(unchanged);
    expect(await client.request("environment.setIcon", { commandId: randomUUID(), icon: "server" })).toEqual(unchanged);
    expect(await client.request("environment.setColour", { commandId: randomUUID(), colour: held.colour ?? "red" })).toEqual(unchanged);
    expect(t.env.log.head()).toBe(head);
    // A name that differs by its case alone is another name.
    expect((await client.request("environment.rename", { commandId: randomUUID(), name: "LAB" })).receipt).toMatchObject({ changed: true });
  });

  it("refuse a client session below admin forbidden, and a name outside the rule, an unknown icon or a literal colour invalid_params, appending nothing", async () => {
    const t = await start();
    const writer = await scopedClient(t, ["read", "sessions:write", "runs:drive", "terminal"]);
    const admin = await t.client();
    const head = t.env.log.head();
    for (const request of [
      writer.request("environment.rename", { commandId: randomUUID(), name: "LAB" }),
      writer.request("environment.setIcon", { commandId: randomUUID(), icon: "nas" }),
      writer.request("environment.setColour", { commandId: randomUUID(), colour: "amber" }),
    ]) {
      expect(await refusal(request)).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    }
    for (const name of ["", "   ", "x".repeat(41), "a\u0000b", "a\u200bb"]) {
      expect(await refusal(admin.request("environment.rename", { commandId: randomUUID(), name })), JSON.stringify(name)).toMatchObject({ code: "invalid_params" });
    }
    expect(await refusal(admin.request("environment.setIcon", { commandId: randomUUID(), icon: "phone" as never }))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(admin.request("environment.setColour", { commandId: randomUUID(), colour: "#ffbf00" as never }))).toMatchObject({ code: "invalid_params" });
    expect(t.env.log.head()).toBe(head);
  });

  it("show in the next discovery answer, the next hello and environment.subscribe's notices, and are kept by a restart and a rebuild", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await startTestEnvironment({ dataDir, hostname: "lab", platform: "linux" });
    const client = await t.client();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((f) => f.type === "synchronized" && f.subscription === subscription);

    // The preset colour is a hash of the new environment's random id, so a fixed colour is already held one start in twelve:
    // set changed false, it appends no notice for the wait below (#703).
    const colour = (await discoveredLook(t.address)).colour === "lime" ? "teal" : "lime";
    const changed = { receipt: { status: "accepted", changed: true } };
    expect(await client.request("environment.rename", { commandId: randomUUID(), name: "SAMPLE-SERVER" })).toMatchObject(changed);
    expect(await client.request("environment.setIcon", { commandId: randomUUID(), icon: "lab" })).toMatchObject(changed);
    expect(await client.request("environment.setColour", { commandId: randomUUID(), colour })).toMatchObject(changed);
    const look: EnvironmentLook = { name: "SAMPLE-SERVER", icon: "lab", colour };
    expect(await discoveredLook(t.address)).toEqual(look);
    expect(await helloLook(t)).toEqual(look);
    expect(t.env.name).toBe("SAMPLE-SERVER");

    const notices: EnvironmentNotice[] = [];
    for (let i = 0; i < 3; i++) {
      const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
      notices.push(EnvironmentNotice.parse(frame.event));
    }
    expect(notices).toEqual([
      { type: "environment.renamed", payload: { name: "SAMPLE-SERVER" } },
      { type: "environment.icon-set", payload: { icon: "lab" } },
      { type: "environment.colour-set", payload: { colour } },
    ]);

    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await discoveredLook(t.address)).toEqual(look);
    const record = readFileSync(join(dataDir, "environment.json"), "utf8");
    await t.close();

    // The record keeps its id, creation time and first name; the look is the log's.
    expect(JSON.parse(record)).toEqual({ id: t.env.id, createdAt: MANUAL_CLOCK_START, name: "lab" });
    const again = await start({ dataDir, hostname: "elsewhere" });
    expect(await discoveredLook(again.address)).toEqual(look);
  });
});
