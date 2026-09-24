import { createServer } from "node:net";
import { request } from "node:http";
import { DISCOVERY_PATH, DiscoveryDocument, HEALTH_PATH, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ByeError, connectClient, openSocket } from "../../test/wire-client.js";
import type { Address } from "./http.js";

const { onCleanup } = useCleanups();

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

const detector = (tailscaleAddress: string | undefined, tailnetName?: string) => ({
  tailscaleAddress: () => tailscaleAddress,
  tailnetName: () => tailnetName,
});

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
      expect(await client.request("environment.status", {})).toEqual({ readiness: "ready" });
    });

    it("binds a LAN address when LAN binding is on, and reports the policy tailnet", async () => {
      const t = await start({ bindLan: true, lanAddress: OTHER_ALIAS });
      expect(t.env.addresses.map((a) => a.host)).toEqual(["127.0.0.1", OTHER_ALIAS]);
      expect(t.env.authPolicy).toBe("tailnet");
      expect((await get({ host: OTHER_ALIAS, port: t.address.port }, HEALTH_PATH)).status).toBe(200);
    });
  });
});
