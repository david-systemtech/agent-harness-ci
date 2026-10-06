import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimLauncher, launcherClaimAddress, type LauncherClaim } from "./launcher-claim.js";

/**
 * The claim a launcher holds on its data directory (#1712). Windows names a
 * pipe; here a Unix socket in a fresh folder stands in for it, which Node
 * listens on and connects to the same way.
 */

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const socketAddress = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ah-claim-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "launcher.sock");
};

const claimed = async (address: string): Promise<LauncherClaim> => {
  const result = await claimLauncher(address);
  if (!("claimed" in result)) throw new Error(`held by ${JSON.stringify(result.heldBy)}`);
  cleanups.push(() => result.claimed.release());
  return result.claimed;
};

describe.runIf(process.platform !== "win32")("the launcher's claim on its data directory", () => {
  it("is held by one launcher at a time: a second is told the holder's pid, and whether it is stopping", async () => {
    const address = socketAddress();
    const first = await claimed(address);
    expect(await claimLauncher(address)).toEqual({ heldBy: { pid: process.pid, stopping: false } });
    first.markStopping();
    expect(await claimLauncher(address)).toEqual({ heldBy: { pid: process.pid, stopping: true } });
  });

  it("can be claimed again once its holder lets go", async () => {
    const address = socketAddress();
    const first = await claimed(address);
    await first.release();
    const second = await claimLauncher(address);
    expect("claimed" in second).toBe(true);
    if ("claimed" in second) await second.claimed.release();
  });
});

describe("the launcher claim's address", () => {
  it("is a named pipe per data directory, the same however Windows cases its path", () => {
    const address = launcherClaimAddress("C:\\Users\\someone\\AppData\\Local\\agent-harness");
    expect(address).toMatch(/^\\\\\.\\pipe\\agent-harness-launcher-[0-9a-f]{32}$/);
    expect(launcherClaimAddress("c:\\users\\SOMEONE\\appdata\\local\\agent-harness")).toBe(address);
    expect(launcherClaimAddress("C:\\Users\\someone\\AppData\\Local\\agent-harness-2")).not.toBe(address);
  });
});
