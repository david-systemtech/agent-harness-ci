import { execFileSync } from "node:child_process";
import { BlockList, isIP, isIPv4 } from "node:net";

/**
 * What the environment finds on its machine to bind beside loopback: the
 * Tailscale address, and the tailnet name the Host check admits. Tests pass
 * their own; the environment's is `tailscaleDetector()`.
 */
export interface InterfaceDetector {
  /** The machine's Tailscale IPv4 address; undefined when Tailscale is absent, stopped or logged out. */
  tailscaleAddress(): string | undefined;
  /** The machine's own name on the tailnet (`desk.tail1234.ts.net`), lower case; undefined when there is none. */
  tailnetName(): string | undefined;
}

/** Runs a command and answers its standard output; undefined when it is missing, fails or times out. */
export type CommandRunner = (command: string, args: readonly string[]) => string | undefined;

/** How long the detector waits for the `tailscale` CLI. */
const TAILSCALE_TIMEOUT_MS = 3000;

export const processRunner: CommandRunner = (command, args) => {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: TAILSCALE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
};

/**
 * The environment's detector: `tailscale ip -4` for the address and
 * `tailscale status --json` for the name, through `run`. A machine without
 * the `tailscale` binary on its PATH, or with Tailscale stopped, has neither.
 */
export const tailscaleDetector = (run: CommandRunner = processRunner): InterfaceDetector => ({
  tailscaleAddress() {
    const first = run("tailscale", ["ip", "-4"])?.split(/\r?\n/)[0]?.trim();
    return first !== undefined && isIPv4(first) ? first : undefined;
  },
  tailnetName() {
    const text = run("tailscale", ["status", "--json"]);
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
}

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

/**
 * What the environment binds (env spec, "Binding and discovery"): loopback
 * always; the Tailscale address when one is found and the tailnet setting is
 * on; a LAN address only when LAN binding is on and one is given. Never the
 * wildcard address: asking for it throws.
 */
export const bindList = (choice: BindChoice): { readonly host: string; readonly interface: BoundInterface }[] => {
  const binds: { host: string; interface: BoundInterface }[] = [{ host: LOOPBACK, interface: "loopback" }];
  const add = (host: string, what: BoundInterface) => {
    if (!binds.some((bind) => bind.host === host)) binds.push({ host, interface: what });
  };
  if (choice.tailscaleAddress !== undefined && (choice.bindTailnet ?? true)) add(bindable(choice.tailscaleAddress, "Tailscale"), "tailnet");
  if (choice.bindLan === true && choice.lanAddress !== undefined) add(bindable(choice.lanAddress, "LAN"), "lan");
  return binds;
};
