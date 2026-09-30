import type { OneTimeAllowance, PageArgs, PageCall, PageDriver, PageDriverKind, PageKey, PagePolicy, PageResult, PageVerb } from "@agent-harness/contracts";
import { onTestFinished } from "vitest";
import { cdpConnection, type CdpConnection } from "../src/cdp/connection.js";
import { pipeTransport } from "../src/cdp/pipe.js";
import type { CdpSession } from "../src/cdp/session.js";
import { webSocketTransport } from "../src/cdp/web-socket.js";
import { cdpPageDriver, type PageHost } from "../src/driver/driver.js";
import type { DriverClock, FrameArrival } from "../src/driver/page.js";
import { scriptedCdpPeer, type ScriptedCdpPeer, type ScriptedTarget } from "../src/testing/index.js";

/**
 * The page driver over the scripted CDP peer, on a real wire: the harness
 * the driver's tests drive, as the environment's headless browser, the
 * extension and the dock will drive theirs.
 */

/** The page key the tests' session uses. */
export const PAGE: PageKey = "0f8fad5b-d9cb-469f-a165-70867728950e/7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** A page policy that lists nothing and allows nothing deep off dev sites: the presets of a fresh environment, less the denylist. */
export const plainPolicy: PagePolicy = { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false, browserDomains: [] };

/** A denylist browser-section entry, enabled, as the page policy carries one. */
export const listed = (pattern: string, id = `test:${pattern}`) => ({ id, pattern, note: "", preset: false, enabled: true });

/**
 * A page host over a whole browser's connection with a target per page key,
 * as the headless browser holds its pages (without the contexts and tab
 * rules its own manager adds): `open` makes a target, the other verbs find
 * the one the key has, and the driver letting go is recorded.
 */
export const targetPerKeyHost = (connection: CdpConnection): PageHost & { readonly released: PageKey[]; readonly targets: Map<PageKey, string> } => {
  const targets = new Map<PageKey, string>();
  const released: PageKey[] = [];
  return {
    released,
    targets,
    async attach(pageKey, make): Promise<CdpSession | null> {
      const known = targets.get(pageKey);
      if (known !== undefined) {
        try {
          return await connection.attach(known);
        } catch {
          targets.delete(pageKey);
        }
      }
      if (!make) return null;
      const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
      targets.set(pageKey, targetId as string);
      return connection.attach(targetId as string);
    },
    release: (pageKey) => void released.push(pageKey),
  };
};

/** A clock that moves only when the test moves it. */
export interface ManualClock extends DriverClock {
  advance(ms: number): void;
  pending(): number;
}

export const manualClock = (start = Date.parse("2026-09-30T08:00:00.000Z")): ManualClock => {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { readonly due: number; readonly callback: () => void }>();
  return {
    now: () => new Date(now),
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { due: now + ms, callback });
      return { cancel: () => void timers.delete(id) };
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort(([a, x], [b, y]) => x.due - y.due || a - b)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].due);
        due[1].callback();
      }
      now = until;
    },
    pending: () => timers.size,
  };
};

export interface DrivenOptions {
  readonly kind?: PageDriverKind;
  readonly wire?: "web-socket" | "pipe";
  readonly policy?: PagePolicy;
  readonly addressRule?: (arrival: FrameArrival) => string | null;
  readonly networkAtAttach?: boolean;
  readonly clock?: DriverClock;
}

export interface Driven {
  readonly peer: ScriptedCdpPeer;
  readonly driver: PageDriver;
  readonly host: ReturnType<typeof targetPerKeyHost>;
  /** Performs one verb on the tests' page. */
  perform<V extends PageVerb>(verb: V, args: PageArgs<V>, options?: { readonly allowance?: OneTimeAllowance; readonly pageKey?: PageKey }): Promise<PageResult<V>>;
  /** The target the tests' page has in the peer. */
  page(): ScriptedTarget;
  /** Replaces the page policy the host passes, as the environment sends a Chrome a new one. */
  setPolicy(policy: PagePolicy): void;
}

/** A driver of `kind` over the scripted peer on a loopback WebSocket (or a pipe), closed when the test ends. */
export const driven = async (options: DrivenOptions = {}): Promise<Driven> => {
  const peer = scriptedCdpPeer();
  const transport = options.wire === "pipe" ? pipeTransport(peer.pipe()) : await webSocketTransport(await peer.listen());
  const connection = cdpConnection(transport);
  onTestFinished(async () => {
    connection.close();
    await peer.close();
  });
  let policy = options.policy ?? plainPolicy;
  const host = targetPerKeyHost(connection);
  const driver = cdpPageDriver({
    kind: options.kind ?? "chrome",
    host,
    policy: () => policy,
    ...(options.addressRule && { addressRule: options.addressRule }),
    ...(options.networkAtAttach !== undefined && { networkAtAttach: options.networkAtAttach }),
    ...(options.clock && { clock: options.clock }),
  });
  return {
    peer,
    driver,
    host,
    perform: (verb, args, extra = {}) =>
      driver.perform({
        pageKey: extra.pageKey ?? PAGE,
        command: { verb, args } as unknown as PageCall["command"],
        ...(extra.allowance && { allowance: extra.allowance }),
      } as never),
    page() {
      const targetId = host.targets.get(PAGE);
      if (targetId === undefined) throw new Error("The tests' page has no target yet: open it first.");
      return peer.target(targetId);
    },
    setPolicy: (next) => void (policy = next),
  };
};

/** The domains enabled on each target, in the order the peer was asked. */
export const enabledDomains = (peer: ScriptedCdpPeer): string[] => peer.sent.filter((command) => /\.enable$/.test(command.method)).map((command) => command.method);
