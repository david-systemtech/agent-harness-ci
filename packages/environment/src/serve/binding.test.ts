import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { request } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { DISCOVERY_PATH, DiscoveryDocument, HEALTH_PATH, PROTOCOL_VERSION, type SettingsPatch, type SnapshotFrame } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ByeError, connectClient, openSocket, type WireClient } from "../../test/wire-client.js";
import type { Address } from "./http.js";
import { tailscaleDetector, type InterfaceDetector } from "./interfaces.js";

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** Whether this machine lets a listener bind `host`: a second loopback address stands in for a tailnet one. */
const canBind = (host: string) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });

const ALIAS = "127.0.0.2";
const OTHER_ALIAS = "127.0.0.3";
const aliases = (await canBind(ALIAS)) && (await canBind(OTHER_ALIAS));

/** A GET with our own Host header, on a chosen address. */
const get = (address: Address, path: string, host = `${address.host}:${address.port}`) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: address.host, port: address.port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

const discovery = async (address: Address) => DiscoveryDocument.parse(JSON.parse((await get(address, DISCOVERY_PATH)).body));

/** A machine whose Tailscale address and name, and whose LAN addresses, are what the test says. */
const detector = (tailscaleAddress: string | undefined, tailnetName?: string, lanAddresses: readonly string[] = []): InterfaceDetector => ({
  tailscaleAddress: async () => tailscaleAddress,
  tailnetName: async () => tailnetName,
  lanAddresses: () => lanAddresses,
});

/** The lines written on standard error from now until the test ends. */
const standardError = (): string[] => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  onCleanup(() => spy.mockRestore());
  return lines;
};

/** Writes `values` through settings.update, as the Your machines card does. */
const write = async (client: WireClient, values: SettingsPatch): Promise<void> => {
  const { receipt } = await client.request("settings.update", { commandId: randomUUID(), values });
  expect(receipt.status).toBe("accepted");
};

/** What `environment.status` says the environment binds. */
const binding = async (t: TestEnvironment) => (await (await t.client()).request("environment.status", {})).binding;

/**
 * Starts an environment on `dataDir`, writes `values` through settings.update
 * and closes it: the keys the next start on that directory applies.
 */
const written = async (dataDir: string, interfaces: InterfaceDetector, values: SettingsPatch): Promise<void> => {
  const t = await startTestEnvironment({ dataDir, interfaces });
  try {
    await write(await t.client(), values);
  } finally {
    await t.close();
  }
};

describe("binding", () => {
  it("binds loopback alone when no Tailscale address is found, and reports the policy local-only", async () => {
    const t = await start({ interfaces: detector(undefined) });
    expect(t.env.addresses).toEqual([{ host: "127.0.0.1", port: t.address.port }]);
    expect(t.env.authPolicy).toBe("local-only");
    expect(await discovery(t.address)).toMatchObject({ authPolicy: "local-only", protocolVersion: PROTOCOL_VERSION });
  });

  it("binds loopback alone when the tailnet setting is off, whatever is found", async () => {
    const t = await start({ interfaces: detector(ALIAS, "desk.tail1234.ts.net"), bindTailnet: false });
    expect(t.env.addresses).toEqual([{ host: "127.0.0.1", port: t.address.port }]);
    expect(t.env.authPolicy).toBe("local-only");
  });

  it("does not bind a LAN address unless LAN binding is on", async () => {
    const t = await start({ lanAddress: OTHER_ALIAS });
    expect(t.env.addresses).toHaveLength(1);
    expect(t.env.authPolicy).toBe("local-only");
  });

  it("refuses the tailnet name in the Host header while the tailnet is not bound", async () => {
    for (const options of [{ interfaces: detector(undefined, "desk.tail1234.ts.net") }, { interfaces: detector(ALIAS, "desk.tail1234.ts.net"), bindTailnet: false }]) {
      const t = await start(options);
      expect((await get(t.address, HEALTH_PATH, "desk.tail1234.ts.net")).status).toBe(421);
      expect((await get(t.address, HEALTH_PATH, "localhost")).status).toBe(200);
    }
  });

  it("fails the start at the listen step when LAN binding is on and no LAN address is given, naming it", async () => {
    await expect(startTestEnvironment({ bindLan: true })).rejects.toMatchObject({
      step: "listen",
      message: expect.stringContaining("no LAN address"),
    });
  });

  it("says on environment.status and in the snapshot that it binds nothing beside loopback, and which LAN addresses its machine holds now, which it could bind", async () => {
    const held = ["192.168.1.20", "fd00::20"];
    const t = await start({ interfaces: { ...detector(undefined), lanAddresses: () => held } });
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: null, lan: null, lanAddresses: ["192.168.1.20", "fd00::20"] });
    held.pop();
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: null, lan: null, lanAddresses: ["192.168.1.20"] });
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const snapshot = await client.next((f): f is SnapshotFrame => f.type === "snapshot" && f.subscription === subscription);
    expect(snapshot.payload).toMatchObject({ status: { binding: { tailnet: null, lan: null, lanAddresses: ["192.168.1.20"] } } });
  });

  it("reports an installed but unreadable Tailscale and refreshes installation on Check again", async () => {
    let installed = true;
    const t = await start({ interfaces: { ...detector(undefined), tailscaleInstalled: () => installed } });
    expect(await binding(t)).toMatchObject({ tailnet: null, tailnetFound: null, tailscaleInstalled: true });
    installed = false;
    expect(await binding(t)).toMatchObject({ tailscaleInstalled: false });
  });

  it("keeps an unidentified Mac VPN local-only in status, discovery and pairing even with Tailscale installed", async () => {
    const interfaces = tailscaleDetector(async () => undefined, () => ({
      utun4: [{ address: "100.64.0.9", internal: false, family: "IPv4" } as NetworkInterfaceInfo],
    }), { platform: "darwin", readInstalled: () => true });
    const t = await start({ interfaces });
    expect(await binding(t)).toMatchObject({ tailnet: null, tailnetFound: null, tailscaleInstalled: true });
    expect(await discovery(t.address)).toMatchObject({ authPolicy: "local-only" });
    expect((await t.createPairing()).link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${t.address.port}/pair#`));
  });

  it("says on environment.status a Tailscale address found since its start, which it binds only at its next start, looking again at each status (#861)", async () => {
    let tailscale: string | undefined;
    const t = await start({ interfaces: { ...detector(undefined), tailscaleAddress: async () => tailscale } });
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] });
    // Tailscale installed since the start: found, not bound.
    tailscale = "100.64.0.9";
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: "100.64.0.9", lan: null, lanAddresses: [] });
    expect(t.env.addresses).toEqual([{ host: "127.0.0.1", port: t.address.port }]);
    expect(t.env.authPolicy).toBe("local-only");
    // Stopped again: found no more.
    tailscale = undefined;
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] });
  });

  it("says on environment.status the Tailscale address it found at its start with network.bindTailnet off, which it does not bind", async () => {
    const t = await start({ interfaces: detector("100.64.0.9", "desk.tail1234.ts.net"), bindTailnet: false });
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: "100.64.0.9", lan: null, lanAddresses: [] });
  });

  it("fails no check of the Your machines step with no tailnet address found: binding none is a notice on its card", async () => {
    const t = await start({ interfaces: detector(undefined, undefined, ["192.168.1.20"]) });
    const client = await t.client();
    // With auto-update off, the release channel's check holds without a read (#346).
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.autoUpdate": false } });
    expect((await client.request("setup.check", { step: "your-machines" })).results[0]).toMatchObject({ state: "done", failing: [] });
  });

  it("starts without the LAN address network.bindLan names once the machine no longer holds it, on loopback, saying so on standard error and on the Your machines step until LAN binding is off", async () => {
    const dataDir = join(tempDir(), "data");
    await written(dataDir, detector(undefined, undefined, ["192.0.2.10"]), { "network.bindLan": "192.0.2.10" });
    const lines = standardError();

    const t = await start({ dataDir, interfaces: detector(undefined, undefined, ["192.168.1.20"]) });
    expect(t.env.addresses).toEqual([{ host: "127.0.0.1", port: t.address.port }]);
    expect(await binding(t)).toEqual({ tailnet: null, tailnetFound: null, lan: null, lanAddresses: ["192.168.1.20"] });
    expect(lines.filter((line) => line.includes("192.0.2.10"))).toEqual([
      "The LAN address 192.0.2.10 is not an address this machine holds (it holds 192.168.1.20), so the environment starts without it: pick one it holds on the Your machines step, or turn LAN binding off.",
    ]);

    const client = await t.client();
    // With auto-update off, the release channel's check holds without a read (#346).
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.autoUpdate": false } });
    expect((await client.request("setup.check", { step: "your-machines" })).results[0]).toMatchObject({
      state: "needs-attention",
      reason: "The network address 192.0.2.10 is no longer on this computer.",
      details: ["network.bindLan: 192.0.2.10", "Addresses this computer holds: 192.168.1.20"],
      failing: ["your-machines.lan"],
      actions: ["check-again"],
    });
    await write(client, { "network.bindLan": null });
    expect((await client.request("setup.check", { step: "your-machines" })).results[0]).toMatchObject({ state: "done", failing: [] });
  });

  it("never binds the wildcard address: a start asked to fails at the listen step", async () => {
    for (const options of [{ interfaces: detector("0.0.0.0") }, { bindLan: true, lanAddress: "::" }]) {
      await expect(startTestEnvironment(options), JSON.stringify(options)).rejects.toMatchObject({
        step: "listen",
        message: expect.stringContaining("wildcard"),
      });
    }
  });

  describe.runIf(aliases)("on a second address (a second loopback address stands in for the tailnet's)", () => {
    it("binds the Tailscale address beside loopback on the same port, and reports the policy tailnet", async () => {
      const t = await start({ interfaces: detector(ALIAS, "desk.tail1234.ts.net") });
      expect(t.env.addresses).toEqual([
        { host: "127.0.0.1", port: t.address.port },
        { host: ALIAS, port: t.address.port },
      ]);
      expect(t.env.authPolicy).toBe("tailnet");
      const tailnet = { host: ALIAS, port: t.address.port };
      expect(await discovery(tailnet)).toMatchObject({ environmentId: t.env.id, authPolicy: "tailnet" });
      expect(await discovery(t.address)).toMatchObject({ authPolicy: "tailnet" });
    });

    it("admits the environment's own tailnet name and its bound addresses in the Host header, and nothing else", async () => {
      const t = await start({ interfaces: detector(ALIAS, "desk.tail1234.ts.net") });
      const tailnet = { host: ALIAS, port: t.address.port };
      for (const host of ["desk.tail1234.ts.net", `desk.tail1234.ts.net:${t.address.port}`, `${ALIAS}:${t.address.port}`, "localhost"]) {
        expect((await get(tailnet, HEALTH_PATH, host)).status, host).toBe(200);
      }
      for (const host of ["other.tail1234.ts.net", "evil.example", `${OTHER_ALIAS}:${t.address.port}`]) {
        expect((await get(tailnet, HEALTH_PATH, host)).status, host).toBe(421);
      }
    });

    it("links a pairing to the tailnet name when there is one, else to the tailnet address", async () => {
      const named = await start({ interfaces: detector(ALIAS, "desk.tail1234.ts.net") });
      expect((await named.createPairing()).link).toMatch(new RegExp(`^http://desk\\.tail1234\\.ts\\.net:${named.address.port}/pair#`));
      const unnamed = await start({ interfaces: detector(ALIAS) });
      expect((await unnamed.createPairing()).link).toMatch(new RegExp(`^http://127\\.0\\.0\\.2:${unnamed.address.port}/pair#`));
    });

    it("takes the pairing exchange on the tailnet address", async () => {
      const t = await start({ interfaces: detector(ALIAS) });
      const { code } = await t.createPairing();
      const response = await fetch(`http://${ALIAS}:${t.address.port}/api/pair`, {
        method: "POST",
        body: JSON.stringify({ code, kind: "web", label: "phone", protocolVersion: PROTOCOL_VERSION }),
      });
      expect(response.status).toBe(200);
    });

    it("refuses a socket without a valid client session under the tailnet policy, as under local-only", async () => {
      const t = await start({ interfaces: detector(ALIAS) });
      expect(t.env.authPolicy).toBe("tailnet");
      const tailnet = { host: ALIAS, port: t.address.port };
      const refused = await connectClient(tailnet, { token: "not a token" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ByeError);
      expect((refused as ByeError).bye?.reason).toBe("unauthorized");
      const unauthenticated = await openSocket(tailnet);
      unauthenticated.send({ type: "request", id: "1", method: "access.sessions.list", params: {} });
      expect((await unauthenticated.closed).bye?.reason).toBe("unauthorized");
      const { token } = await t.pair({ kind: "web" });
      const client = await connectClient(tailnet, { token, clientKind: "web" });
      onCleanup(() => client.close());
      expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
    });

    it("binds a LAN address when LAN binding is on, and reports the policy tailnet", async () => {
      const t = await start({ interfaces: detector(undefined, undefined, [OTHER_ALIAS]), bindLan: true, lanAddress: OTHER_ALIAS });
      expect(t.env.addresses.map((a) => a.host)).toEqual(["127.0.0.1", OTHER_ALIAS]);
      expect(t.env.authPolicy).toBe("tailnet");
      expect((await get({ host: OTHER_ALIAS, port: t.address.port }, HEALTH_PATH)).status).toBe(200);
    });

    it("says on environment.status that it binds the tailnet address, with its tailnet name, and the LAN addresses it could bind", async () => {
      const t = await start({ interfaces: detector(ALIAS, "desk.tail1234.ts.net", [OTHER_ALIAS]) });
      expect(await binding(t)).toEqual({ tailnet: { address: ALIAS, name: "desk.tail1234.ts.net" }, tailnetFound: null, lan: null, lanAddresses: [OTHER_ALIAS] });
      const unnamed = await start({ interfaces: detector(ALIAS) });
      expect(await binding(unnamed)).toEqual({ tailnet: { address: ALIAS, name: null }, tailnetFound: null, lan: null, lanAddresses: [] });
    });

    it("applies network.bindTailnet at the next start: written off, the restart binds loopback alone and says it binds no tailnet; written on again, the next binds the tailnet address", async () => {
      const dataDir = join(tempDir(), "data");
      const machine = detector(ALIAS, "desk.tail1234.ts.net", [OTHER_ALIAS]);
      await written(dataDir, machine, { "network.bindTailnet": false });

      const off = await startTestEnvironment({ dataDir, interfaces: machine });
      expect(off.env.addresses).toEqual([{ host: "127.0.0.1", port: off.address.port }]);
      expect(off.env.authPolicy).toBe("local-only");
      expect(await binding(off)).toEqual({ tailnet: null, tailnetFound: ALIAS, lan: null, lanAddresses: [OTHER_ALIAS] });
      await write(await off.client(), { "network.bindTailnet": true });
      await off.close();

      const on = await start({ dataDir, interfaces: machine });
      expect(on.env.addresses).toEqual([
        { host: "127.0.0.1", port: on.address.port },
        { host: ALIAS, port: on.address.port },
      ]);
      expect(await binding(on)).toMatchObject({ tailnet: { address: ALIAS, name: "desk.tail1234.ts.net" } });
    });

    it("applies network.bindLan at the next start: an address the machine holds is bound beside loopback and the tailnet and said to be; written off again, the next start binds it no more", async () => {
      const dataDir = join(tempDir(), "data");
      const machine = detector(ALIAS, "desk.tail1234.ts.net", [OTHER_ALIAS]);
      await written(dataDir, machine, { "network.bindLan": OTHER_ALIAS });

      const lan = await startTestEnvironment({ dataDir, interfaces: machine });
      expect(lan.env.addresses.map((address) => address.host)).toEqual(["127.0.0.1", ALIAS, OTHER_ALIAS]);
      expect((await get({ host: OTHER_ALIAS, port: lan.address.port }, HEALTH_PATH)).status).toBe(200);
      expect(await binding(lan)).toEqual({ tailnet: { address: ALIAS, name: "desk.tail1234.ts.net" }, tailnetFound: null, lan: OTHER_ALIAS, lanAddresses: [OTHER_ALIAS] });
      await write(await lan.client(), { "network.bindLan": null });
      await lan.close();

      const off = await start({ dataDir, interfaces: machine });
      expect(off.env.addresses.map((address) => address.host)).toEqual(["127.0.0.1", ALIAS]);
      expect(await binding(off)).toMatchObject({ lan: null });
    });

    it("binds loopback and the tailnet at a start whose network.bindLan names an address the machine no longer holds, skipping the LAN", async () => {
      const dataDir = join(tempDir(), "data");
      await written(dataDir, detector(ALIAS, "desk.tail1234.ts.net", [OTHER_ALIAS]), { "network.bindLan": OTHER_ALIAS });
      standardError();

      const t = await start({ dataDir, interfaces: detector(ALIAS, "desk.tail1234.ts.net", ["192.168.1.20"]) });
      expect(t.env.addresses).toEqual([
        { host: "127.0.0.1", port: t.address.port },
        { host: ALIAS, port: t.address.port },
      ]);
      expect(t.env.authPolicy).toBe("tailnet");
      expect(await binding(t)).toEqual({ tailnet: { address: ALIAS, name: "desk.tail1234.ts.net" }, tailnetFound: null, lan: null, lanAddresses: ["192.168.1.20"] });
    });

    it("takes the start options over both keys, for tests and the service verbs", async () => {
      const dataDir = join(tempDir(), "data");
      const machine = detector(ALIAS, "desk.tail1234.ts.net", [OTHER_ALIAS]);
      await written(dataDir, machine, { "network.bindTailnet": false, "network.bindLan": OTHER_ALIAS });

      const t = await start({ dataDir, interfaces: machine, bindTailnet: true, bindLan: false });
      expect(t.env.addresses.map((address) => address.host)).toEqual(["127.0.0.1", ALIAS]);
      expect(await binding(t)).toMatchObject({ tailnet: { address: ALIAS }, lan: null });
    });
  });
});
