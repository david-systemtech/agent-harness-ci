import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { bindPlan, processRunner, tailscaleDetector, type CommandRunner } from "./interfaces.js";

/** A runner that answers from a table of command lines, and records what it was asked. */
const scripted = (answers: Record<string, string | undefined>) => {
  const asked: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(" ");
    asked.push(line);
    return answers[line];
  };
  return { run, asked };
};

const status = (self: Record<string, unknown>) => JSON.stringify({ BackendState: "Running", Self: self });

/** One scripted kernel interface address. */
const entry = (address: string, internal = false) => ({ address, internal, family: address.includes(":") ? "IPv6" : "IPv4" }) as NetworkInterfaceInfo;


describe("the Tailscale detector", () => {
  it("reads the address from tailscale ip -4 and the name from tailscale status --json", async () => {
    const { run, asked } = scripted({
      "tailscale ip -4": "100.101.102.103\n",
      "tailscale status --json": status({ DNSName: "Desk.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103"] }),
    });
    const detector = tailscaleDetector(run, () => ({}));
    expect(await detector.tailscaleAddress()).toBe("100.101.102.103");
    expect(await detector.tailnetName()).toBe("desk.tail1234.ts.net");
    expect(asked).toEqual(["tailscale ip -4", "tailscale status --json"]);
  });

  it("discovers the host tailnet without a CLI in a container sharing the host network, retaining loopback and leaving LAN opt-in", async () => {
    const detector = tailscaleDetector(scripted({}).run, () => ({
      lo: [entry("127.0.0.1", true)],
      eth0: [entry("192.168.1.20")],
      tailscale0: [entry("fd7a:115c:a1e0::1"), entry("100.101.102.103")],
    }));
    const tailscaleAddress = await detector.tailscaleAddress();
    expect(tailscaleAddress).toBe("100.101.102.103");
    expect(await detector.tailnetName()).toBeUndefined();
    expect(bindPlan({ tailscaleAddress, lanAddresses: detector.lanAddresses() }).binds).toEqual([
      { host: "127.0.0.1", interface: "loopback" },
      { host: "100.101.102.103", interface: "tailnet" },
    ]);
    expect(bindPlan({ tailscaleAddress, bindTailnet: false }).binds).toEqual([{ host: "127.0.0.1", interface: "loopback" }]);
  });

  it("finds nothing when the CLI gives no address and no kernel tailnet interface is present", async () => {
    const detector = tailscaleDetector(scripted({}).run, () => ({}));
    expect(await detector.tailscaleAddress()).toBeUndefined();
    expect(await detector.tailnetName()).toBeUndefined();
  });

  it("takes only an IPv4 address, and the first when there are several", async () => {
    expect(await tailscaleDetector(scripted({ "tailscale ip -4": "not an address\n" }).run, () => ({})).tailscaleAddress()).toBeUndefined();
    expect(await tailscaleDetector(scripted({ "tailscale ip -4": "fd7a:115c:a1e0::1\n" }).run, () => ({})).tailscaleAddress()).toBeUndefined();
    expect(await tailscaleDetector(scripted({ "tailscale ip -4": "100.64.0.1\n100.64.0.2\n" }).run, () => ({})).tailscaleAddress()).toBe("100.64.0.1");
  });

  it("uses only a non-internal IPv4 address in Tailscale's range on tailscale0, reading it anew", async () => {
    let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      eth0: [entry("100.64.0.5")],
      tun0: [entry("100.64.0.6")],
      tailscale0: [entry("192.168.1.20"), entry("100.63.255.255"), entry("100.128.0.1"), entry("100.64.0.7", true), entry("fd7a:115c:a1e0::1")],
    };
    const detector = tailscaleDetector(scripted({}).run, () => interfaces);
    expect(await detector.tailscaleAddress()).toBeUndefined();
    interfaces = { tailscale0: [entry("100.64.0.1")] };
    expect(await detector.tailscaleAddress()).toBe("100.64.0.1");
    interfaces = { tailscale0: [entry("100.127.255.254")] };
    expect(await detector.tailscaleAddress()).toBe("100.127.255.254");
    interfaces = {};
    expect(await detector.tailscaleAddress()).toBeUndefined();
  });

  it("prefers the CLI address to the kernel interface address", async () => {
    const detector = tailscaleDetector(scripted({ "tailscale ip -4": "100.101.102.103\n" }).run, () => ({ tailscale0: [entry("100.64.0.1")] }));
    expect(await detector.tailscaleAddress()).toBe("100.101.102.103");
  });

  it("reads the machine's LAN addresses from its network interfaces each time it is asked: every address but loopback, link-local and Tailscale's, each once", () => {
    let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [entry("127.0.0.1", true), entry("::1", true)],
      eth0: [entry("192.168.1.20"), entry("fe80::1c2b:3aff:fe4d:5e6f"), entry("fd00::20")],
      wlan0: [entry("169.254.10.20"), entry("10.0.0.7"), entry("192.168.1.20")],
      tailscale0: [entry("100.101.102.103"), entry("fd7a:115c:a1e0::1")],
    };
    const detector = tailscaleDetector(scripted({}).run, () => interfaces);
    expect(detector.lanAddresses()).toEqual(["192.168.1.20", "fd00::20", "10.0.0.7"]);
    interfaces = { eth0: [entry("192.168.7.5")] };
    expect(detector.lanAddresses()).toEqual(["192.168.7.5"]);
  });

  it("finds no name when Tailscale is not running, or reports none", async () => {
    for (const text of [
      JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "desk.tail1234.ts.net." } }),
      status({ DNSName: "" }),
      status({}),
      "{ not json",
    ]) {
      expect(await tailscaleDetector(scripted({ "tailscale status --json": text }).run).tailnetName(), text).toBeUndefined();
    }
  });
});

describe("the default runner", () => {
  it("does not block the event loop while the command runs, and answers undefined for a missing binary", async () => {
    let ticked = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => resolve(void (ticked = true))));
    const answer = processRunner(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 200)"]);
    await tick;
    expect(ticked).toBe(true);
    expect(await answer).toBe("done");
    expect(await processRunner("agent-harness-no-such-binary", [])).toBeUndefined();
  });
});

describe("the bind plan", () => {
  /** What the plan for `choice` binds. */
  const bindsOf = (choice: Parameters<typeof bindPlan>[0]) => bindPlan(choice).binds;

  it("is loopback alone when there is no Tailscale address and LAN binding is off", () => {
    expect(bindsOf({})).toEqual([{ host: "127.0.0.1", interface: "loopback" }]);
  });

  it("adds the Tailscale address when one is found, the tailnet setting's preset", () => {
    expect(bindsOf({ tailscaleAddress: "100.101.102.103" })).toEqual([
      { host: "127.0.0.1", interface: "loopback" },
      { host: "100.101.102.103", interface: "tailnet" },
    ]);
    expect(bindsOf({ tailscaleAddress: "100.101.102.103", bindTailnet: true })).toHaveLength(2);
  });

  it("leaves the Tailscale address out when the tailnet setting is off", () => {
    expect(bindsOf({ tailscaleAddress: "100.101.102.103", bindTailnet: false })).toEqual([{ host: "127.0.0.1", interface: "loopback" }]);
  });

  it("binds a LAN address only when LAN binding is on, and refuses LAN binding with no address, naming it", () => {
    const lanAddresses = ["192.168.1.20"];
    expect(bindsOf({ lanAddress: "192.168.1.20", lanAddresses })).toHaveLength(1);
    expect(() => bindsOf({ bindLan: true, lanAddresses })).toThrow(/no LAN address/);
    expect(bindsOf({ lanAddress: "192.168.1.20", bindLan: true, lanAddresses })).toEqual([
      { host: "127.0.0.1", interface: "loopback" },
      { host: "192.168.1.20", interface: "lan" },
    ]);
  });

  it("skips a LAN address the machine does not hold, binding the rest and saying which it holds, and knows one the machine names another way", () => {
    expect(bindPlan({ tailscaleAddress: "100.101.102.103", lanAddress: "192.0.2.10", bindLan: true, lanAddresses: ["192.168.1.20", "fd00::20"] })).toEqual({
      binds: [
        { host: "127.0.0.1", interface: "loopback" },
        { host: "100.101.102.103", interface: "tailnet" },
      ],
      skipped:
        "The LAN address 192.0.2.10 is not an address this machine holds (it holds 192.168.1.20, fd00::20), so the environment starts without it: pick one it holds on the Your machines step, or turn LAN binding off.",
    });
    expect(bindPlan({ lanAddress: "192.168.1.20", bindLan: true }).skipped).toMatch(/it holds none\)/);
    expect(bindPlan({ lanAddress: "FD00:0:0::20", bindLan: true, lanAddresses: ["fd00::20"] })).toEqual({
      binds: [
        { host: "127.0.0.1", interface: "loopback" },
        { host: "FD00:0:0::20", interface: "lan" },
      ],
    });
  });

  it("never binds the wildcard address, nor anything that is not an address", () => {
    for (const address of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::0", "::ffff:0.0.0.0", "::ffff:0:0", "0:0:0:0:0:ffff:0:0", "desk.local", ""]) {
      expect(() => bindsOf({ lanAddress: address, bindLan: true }), address).toThrow();
      expect(() => bindsOf({ tailscaleAddress: address }), address).toThrow();
    }
  });
});
