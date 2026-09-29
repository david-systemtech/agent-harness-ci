import { join } from "node:path";
import { PROTOCOL_VERSION, SCOPES, parsePairingLink } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { DEFAULT_CEILING } from "../auth/client-sessions.js";
import type { ContainerDetector } from "./container.js";

/**
 * The first-start pairing (launcher-update spec, "Containers: the host-side
 * updater"; ADR 0025; #349): a declared container pairs from its own log, so
 * until a client first exchanges a pairing code, each start mints one for
 * `serve` to print. Through the in-process environment with the container
 * detection stubbed.
 */

const { onCleanup, tempDir } = useCleanups();

/** A container the install declared, as the compose file's AGENT_HARNESS_CONTAINER does. */
const DECLARED: ContainerDetector = { inContainer: () => true, declared: () => true };

const start = async (options: TestEnvironmentOptions): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** Exchanges the pairing `t` minted as it started, as a client given its link does; throws unless it minted one. */
const exchange = async (t: TestEnvironment) => {
  const link = t.env.startPairing?.link;
  const code = link === undefined ? undefined : parsePairingLink(link)?.code;
  if (code === undefined) throw new Error("The start minted no pairing to exchange.");
  return t.pairExchange({ code, kind: "web", label: "phone", protocolVersion: PROTOCOL_VERSION });
};

describe("a declared container's start", () => {
  it("mints a pairing each time it starts, until a client exchanges one; after that, none", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir, containerDetector: DECLARED });
    const minted = first.env.startPairing;
    expect(minted).toMatchObject({ scopes: [...SCOPES], ceiling: DEFAULT_CEILING });
    expect(parsePairingLink(minted?.link ?? "")?.origin).toBe(`http://127.0.0.1:${first.address.port}`);
    await first.close();

    // Nobody paired: the next start mints another.
    const second = await start({ dataDir, containerDetector: DECLARED });
    expect(second.env.startPairing).toBeDefined();
    expect(second.env.startPairing?.code).not.toBe(minted?.code);
    expect((await exchange(second)).status).toBe(200);
    await second.close();

    const third = await start({ dataDir, containerDetector: DECLARED });
    expect(third.env.startPairing).toBeUndefined();
  });

  it("mints none once any pairing was exchanged, whoever minted it", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir, containerDetector: DECLARED });
    await first.pair();
    await first.close();

    const again = await start({ dataDir, containerDetector: DECLARED });
    expect(again.env.startPairing).toBeUndefined();
  });
});

describe("any other start", () => {
  it("mints no pairing: a container only detected, a native environment, or a detector that says nothing of a declaration", async () => {
    for (const containerDetector of [
      { inContainer: () => true, declared: () => false },
      { inContainer: () => false, declared: () => false },
      { inContainer: () => true },
    ]) {
      const t = await start({ containerDetector });
      expect(t.env.startPairing, JSON.stringify({ inContainer: containerDetector.inContainer(), declared: containerDetector.declared?.() })).toBeUndefined();
    }
  });
});
