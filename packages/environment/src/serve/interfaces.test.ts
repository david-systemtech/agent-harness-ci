import { describe, expect, it } from "vitest";
import { bindList, tailscaleDetector, type CommandRunner } from "./interfaces.js";

/** A runner that answers from a table of command lines, and records what it was asked. */
const scripted = (answers: Record<string, string | undefined>) => {
  const asked: string[] = [];
  const run: CommandRunner = (command, args) => {
    const line = [command, ...args].join(" ");
    asked.push(line);
    return answers[line];
  };
  return { run, asked };
};

const status = (self: Record<string, unknown>) => JSON.stringify({ BackendState: "Running", Self: self });

describe("the Tailscale detector", () => {
  it("reads the address from tailscale ip -4 and the name from tailscale status --json", () => {
    const { run, asked } = scripted({
      "tailscale ip -4": "100.101.102.103\n",
      "tailscale status --json": status({ DNSName: "Desk.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103"] }),
    });
    const detector = tailscaleDetector(run);
    expect(detector.tailscaleAddress()).toBe("100.101.102.103");
    expect(detector.tailnetName()).toBe("desk.tail1234.ts.net");
    expect(asked).toEqual(["tailscale ip -4", "tailscale status --json"]);
  });

  it("finds nothing when the binary is missing or fails", () => {
    const detector = tailscaleDetector(scripted({}).run);
    expect(detector.tailscaleAddress()).toBeUndefined();
    expect(detector.tailnetName()).toBeUndefined();
  });

  it("takes only an IPv4 address, and the first when there are several", () => {
    expect(tailscaleDetector(scripted({ "tailscale ip -4": "not an address\n" }).run).tailscaleAddress()).toBeUndefined();
    expect(tailscaleDetector(scripted({ "tailscale ip -4": "fd7a:115c:a1e0::1\n" }).run).tailscaleAddress()).toBeUndefined();
    expect(tailscaleDetector(scripted({ "tailscale ip -4": "100.64.0.1\n100.64.0.2\n" }).run).tailscaleAddress()).toBe("100.64.0.1");
  });

  it("finds no name when Tailscale is not running, or reports none", () => {
    for (const text of [
      JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "desk.tail1234.ts.net." } }),
      status({ DNSName: "" }),
      status({}),
      "{ not json",
    ]) {
      expect(tailscaleDetector(scripted({ "tailscale status --json": text }).run).tailnetName(), text).toBeUndefined();
    }
  });
});

describe("the bind list", () => {
  it("is loopback alone when there is no Tailscale address and LAN binding is off", () => {
    expect(bindList({})).toEqual([{ host: "127.0.0.1", interface: "loopback" }]);
  });

  it("adds the Tailscale address when one is found, the tailnet setting's preset", () => {
    expect(bindList({ tailscaleAddress: "100.101.102.103" })).toEqual([
      { host: "127.0.0.1", interface: "loopback" },
      { host: "100.101.102.103", interface: "tailnet" },
    ]);
    expect(bindList({ tailscaleAddress: "100.101.102.103", bindTailnet: true })).toHaveLength(2);
  });

  it("leaves the Tailscale address out when the tailnet setting is off", () => {
    expect(bindList({ tailscaleAddress: "100.101.102.103", bindTailnet: false })).toEqual([{ host: "127.0.0.1", interface: "loopback" }]);
  });

  it("binds a LAN address only when LAN binding is on and an address is given", () => {
    expect(bindList({ lanAddress: "192.168.1.20" })).toHaveLength(1);
    expect(bindList({ bindLan: true })).toHaveLength(1);
    expect(bindList({ lanAddress: "192.168.1.20", bindLan: true })).toEqual([
      { host: "127.0.0.1", interface: "loopback" },
      { host: "192.168.1.20", interface: "lan" },
    ]);
  });

  it("never binds the wildcard address, nor anything that is not an address", () => {
    for (const address of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::0", "desk.local", ""]) {
      expect(() => bindList({ lanAddress: address, bindLan: true }), address).toThrow();
      expect(() => bindList({ tailscaleAddress: address }), address).toThrow();
    }
  });
});
