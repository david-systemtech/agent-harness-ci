import { execFile } from "node:child_process";
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { promisify } from "node:util";

/**
 * What the environment finds on its machine to bind beside loopback: the
 * Tailscale address, the tailnet name the Host check admits, and the LAN
 * addresses a LAN bind may name. Tests pass their own; the environment's is
 * `tailscaleDetector()`.
 */
export interface InterfaceDetector {
  /** The machine's Tailscale IPv4 address; undefined when Tailscale is absent, stopped or logged out. */
  tailscaleAddress(): Promise<string | undefined>;
  /** The machine's own name on the tailnet (`desk.tail1234.ts.net`), lower case; undefined when there is none. */
  tailnetName(): Promise<string | undefined>;
  /** The machine's LAN addresses as it holds them now: what `network.bindLan` may name (#574). */
  lanAddresses(): readonly string[];
}

/** Runs a command and answers its standard output; undefined when it is missing, fails or times out. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string | undefined>;

/** How long the detector waits for the `tailscale` CLI. */
const TAILSCALE_TIMEOUT_MS = 3000;

const run = promisify(execFile);

/** Runs `command` without blocking the event loop, killed after three seconds. */
export const processRunner: CommandRunner = async (command, args) => {
  try {
    return (await run(command, [...args], { encoding: "utf8", timeout: TAILSCALE_TIMEOUT_MS, windowsHide: true })).stdout;
  } catch {
    return undefined;
  }
};

/** Addresses no LAN bind names: link-local ones, which need an interface to bind, and Tailscale's own ranges, the tailnet's to bind. */
const notLan = new BlockList();
notLan.addSubnet("169.254.0.0", 16, "ipv4");
notLan.addSubnet("fe80::", 10, "ipv6");
notLan.addSubnet("100.64.0.0", 10, "ipv4");
notLan.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * The LAN addresses among a machine's network interfaces (`os.networkInterfaces()`),
 * each once in their order: every address but loopback, link-local and
 * Tailscale's.
 */
export const lanAddressesOf = (interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] => [
  ...new Set(
    Object.values(interfaces)
      .flatMap((entries) => entries ?? [])
      .filter((entry) => !entry.internal && !notLan.check(entry.address, isIPv6(entry.address) ? "ipv6" : "ipv4"))
      .map((entry) => entry.address),
  ),
];

/**
 * The environment's detector: `tailscale ip -4` for the address and
 * `tailscale status --json` for the name, through `run`, and the machine's
 * network interfaces, read each time, for its LAN addresses. A machine
 * without the `tailscale` binary on its PATH, or with Tailscale stopped, has
 * neither address nor name.
 */
export const tailscaleDetector = (
  runner: CommandRunner = processRunner,
  readInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): InterfaceDetector => ({
  lanAddresses: () => lanAddressesOf(readInterfaces()),
  async tailscaleAddress() {
    const first = (await runner("tailscale", ["ip", "-4"]))?.split(/\r?\n/)[0]?.trim();
    return first !== undefined && isIPv4(first) ? first : undefined;
  },
  async tailnetName() {
    const text = await runner("tailscale", ["status", "--json"]);
    if (text === undefined) return undefined;
    let status: unknown;
    try {
      status = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof status !== "object" || status === null) return undefined;
    const { BackendState: state, Self: self } = status as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    if (state !== "Running" || typeof self?.DNSName !== "string") return undefined;
    const name = self.DNSName.replace(/\.$/, "").toLowerCase();
    return name === "" ? undefined : name;
  },
});

/** The loopback address the environment always binds. */
export const LOOPBACK = "127.0.0.1";

/** Which interface a bound address is. */
export type BoundInterface = "loopback" | "tailnet" | "lan";

export interface BindChoice {
  /** The Tailscale address the detector found, if any. */
  readonly tailscaleAddress?: string | undefined;
  /** The tailnet setting: preset on when an address is found. */
  readonly bindTailnet?: boolean | undefined;
  /** The LAN setting: preset off. */
  readonly bindLan?: boolean | undefined;
  /** The LAN address to bind when LAN binding is on. */
  readonly lanAddress?: string | undefined;
  /** The LAN addresses the machine holds, the detector's: the LAN address bound must be one. Preset: none. */
  readonly lanAddresses?: readonly string[] | undefined;
}

/**
 * What a start binds beside loopback (#574): the start options where they
 * are given, which override both keys for tests and the service verbs,
 * else the binding keys as the settings hold them. A start option turning
 * LAN binding on or off takes its own LAN address, or none.
 */
export const bindChoiceOf = (
  keys: { readonly bindTailnet: boolean; readonly bindLan: string | null },
  options: Pick<BindChoice, "bindTailnet" | "bindLan" | "lanAddress">,
): Pick<BindChoice, "bindTailnet" | "bindLan" | "lanAddress"> =>
  options.bindLan === undefined
    ? { bindTailnet: options.bindTailnet ?? keys.bindTailnet, bindLan: keys.bindLan !== null, lanAddress: keys.bindLan ?? undefined }
    : { bindTailnet: options.bindTailnet ?? keys.bindTailnet, bindLan: options.bindLan, lanAddress: options.lanAddress };

/** An address as the machine names it: an IPv6 address compressed and in lower case, so `FD00:0::20` is `fd00::20`. */
const canonical = (address: string): string => (isIPv6(address) ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address);

const wildcards = new BlockList();
wildcards.addAddress("0.0.0.0", "ipv4");
wildcards.addAddress("::", "ipv6");

/** `address`, refused unless it is one IP address and not the wildcard. */
const bindable = (address: string, what: string): string => {
  const family = isIP(address);
  if (family === 0) throw new Error(`The ${what} address ${JSON.stringify(address)} is not an IP address.`);
  if (wildcards.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw new Error(`The ${what} address ${address} is the wildcard address, which the environment never binds.`);
  }
  return address;
};

/** One listener a start binds: its address, and which interface that is. */
export interface Bind {
  readonly host: string;
  readonly interface: BoundInterface;
}

/** What a start binds, and the line it says when it skips the LAN address it was asked for. */
export interface BindPlan {
  /** Loopback first, then the tailnet's and the LAN's addresses where they are bound. */
  readonly binds: readonly Bind[];
  /** Why the LAN address asked for is not bound, for standard error: the machine does not hold it (#773). Undefined when none was skipped. */
  readonly skipped?: string;
}

/**
 * The sentence saying the LAN address `address` is not one the machine,
 * holding `held`, holds, naming those it does; true when it holds it,
 * however either is written.
 */
export const lanAddressHeld = (address: string, held: readonly string[]): true | string =>
  held.some((each) => canonical(each) === canonical(address)) ||
  `The LAN address ${address} is not an address this machine holds (it holds ${held.length === 0 ? "none" : held.join(", ")})`;

/**
 * What the environment binds (env spec, "Binding and discovery"): loopback
 * always; the Tailscale address when one is found and the tailnet setting is
 * on; the LAN address when LAN binding is on, which without an address
 * throws saying so. A LAN address the machine does not hold is skipped, not
 * refused (#773): a laptop that joined another network still starts, on
 * loopback and the tailnet, and the plan says why. Never the wildcard
 * address: asking for it throws.
 */
export const bindPlan = (choice: BindChoice): BindPlan => {
  const binds: Bind[] = [{ host: LOOPBACK, interface: "loopback" }];
  const add = (host: string, what: BoundInterface) => {
    if (!binds.some((bind) => bind.host === host)) binds.push({ host, interface: what });
  };
  if (choice.tailscaleAddress !== undefined && (choice.bindTailnet ?? true)) add(bindable(choice.tailscaleAddress, "Tailscale"), "tailnet");
  if (choice.bindLan !== true) return { binds };
  if (choice.lanAddress === undefined) throw new Error("LAN binding is on, but no LAN address is given to bind: set lanAddress, or turn LAN binding off.");
  const lan = bindable(choice.lanAddress, "LAN");
  const held = lanAddressHeld(lan, choice.lanAddresses ?? []);
  if (held !== true) {
    return { binds, skipped: `${held}, so the environment starts without it: pick one it holds on the Your machines step, or turn LAN binding off.` };
  }
  add(lan, "lan");
  return { binds };
};
