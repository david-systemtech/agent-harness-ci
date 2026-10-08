import { presetSettings, type EnvironmentStatus } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { accountsLine, forgesLine, keyManagersLine, lanHolds, namedHolds, notebooksLine, readyWithinCap, yourMachinesLine } from "./state-checks.js";

/**
 * Your machines' line when done (#1698): what was found, its name and how it
 * is kept up to date, never the conditions of its seven checks, with the
 * version it runs, its updates and where it can be reached in details
 * (#1836); its named, ready and network lines; and the done lines that name
 * what the environment holds.
 */

const ready: EnvironmentStatus = {
  readiness: "ready",
  activity: { state: "idle" },
  updatesManagedOutside: false,
  binding: { tailnet: null, lan: null, lanAddresses: [] },
};

describe("Your machines' line when done", () => {
  it("says the computer is ready by its name and how it is kept up to date, its version, updates and reach in details (setup-copy.md §5.4)", () => {
    const values = presetSettings();
    expect(yourMachinesLine("desk", "0.1.3", ready, values)).toEqual({
      reason: "desk is ready. It updates itself.",
      details: ["Version: 0.1.3", "Updates: on", "Reachable from: this computer only"],
    });
    expect(yourMachinesLine("desk", "0.1.3", ready, { ...values, "updates.autoUpdate": false }).reason).toBe("desk is ready. Automatic updates are off.");
    expect(yourMachinesLine("desk", "0.1.3", ready, { ...values, "updates.pinnedVersion": "0.1.2" })).toMatchObject({
      reason: "desk is ready. It stays on version 0.1.2.",
      details: ["Version: 0.1.3", "Updates: pinned to 0.1.2", "Reachable from: this computer only"],
    });
    expect(yourMachinesLine("desk", "0.1.3", { ...ready, updatesManagedOutside: true }, values).reason).toBe("desk is ready. The host's updater keeps it up to date.");

    const tailnet = { address: "100.64.0.7", name: "desk.tail0000.ts.net" };
    expect(yourMachinesLine("desk", "0.1.3", { ...ready, binding: { tailnet, lan: null, lanAddresses: [] } }, values).details).toEqual([
      "Version: 0.1.3",
      "Updates: on",
      "Tailscale address: 100.64.0.7 (desk.tail0000.ts.net)",
    ]);
    expect(yourMachinesLine("desk", "0.1.3", { ...ready, binding: { tailnet, lan: "192.168.1.20", lanAddresses: ["192.168.1.20"] } }, values).details).toEqual([
      "Version: 0.1.3",
      "Updates: on",
      "Tailscale address: 100.64.0.7 (desk.tail0000.ts.net)",
      "Local network address: 192.168.1.20",
    ]);
    expect(yourMachinesLine("desk", "0.1.3", { ...ready, activity: { state: "draining", drainingSince: "2026-10-06T08:00:00.000Z" } }, values).reason).toBe(
      "desk is restarting. It updates itself.",
    );
  });

  it("says no alternative taken from the checks' conditions, and no version or address in the line", () => {
    const { reason } = yourMachinesLine("desk", "0.1.3", { ...ready, binding: { tailnet: { address: "100.64.0.7", name: null }, lan: null, lanAddresses: [] } }, presetSettings());
    expect(reason).not.toMatch(/\bor\b/);
    expect(reason).not.toMatch(/0\.1\.3|100\.64/);
  });
});

describe("Your machines' named, ready and network lines (setup-copy.md §5.4)", () => {
  it("asks for a name in plain words when the computer has none", () => {
    expect(namedHolds({ name: "desk" })).toBe(true);
    expect(namedHolds({ name: "  " })).toEqual({ reason: "This computer has no name. Give it one in More options." });
  });

  it("says agent-harness is still starting, or has been restarting past its cap with since when in details", () => {
    const now = new Date("2026-10-06T09:00:00.000Z");
    expect(readyWithinCap(ready, now)).toBe(true);
    expect(readyWithinCap({ ...ready, readiness: "starting" } as unknown as EnvironmentStatus, now)).toEqual({ reason: "agent-harness is still starting. This takes a few seconds." });
    expect(readyWithinCap({ ...ready, activity: { state: "draining", drainingSince: "2026-10-06T08:50:00.000Z" } }, now)).toBe(true);
    expect(readyWithinCap({ ...ready, activity: { state: "draining", drainingSince: "2026-10-06T08:00:00.000Z" } }, now)).toEqual({
      reason: "agent-harness has been restarting for over 30 minutes. Choose Check again once it is back.",
      details: ["Restarting since: 2026-10-06T08:00:00.000Z"],
    });
  });

  it("names a network address the computer no longer holds, the addresses it holds in details", () => {
    expect(lanHolds(null, ["192.168.1.20"])).toBe(true);
    expect(lanHolds("192.168.1.20", ["192.168.1.20"])).toBe(true);
    expect(lanHolds("192.168.1.20", ["10.0.0.5", "fd00::20"])).toEqual({
      reason: "The network address 192.168.1.20 is no longer on this computer.",
      details: ["network.bindLan: 192.168.1.20", "Addresses this computer holds: 10.0.0.5, fd00::20"],
    });
    expect(lanHolds("192.168.1.20", [])).toMatchObject({ details: ["network.bindLan: 192.168.1.20", "Addresses this computer holds: none"] });
  });
});

describe("the done lines that name what the environment holds (setup-copy.md §5)", () => {
  it("names the one account signed in, or counts them all", () => {
    expect(accountsLine([{ label: "Work" }])).toEqual({ reason: "Work is signed in." });
    expect(accountsLine([{ label: "Work" }, { label: "Home" }])).toEqual({ reason: "All 2 accounts are signed in.", details: ["Work", "Home"] });
    expect(accountsLine([])).toBeUndefined();
  });

  it("names the one forge connected, or counts them, each forge's address in details", () => {
    const forge = (origin: string, login: string | null) => ({ origin, identity: login === null ? null : { login } });
    expect(forgesLine([forge("https://github.com", "octo")])).toEqual({ reason: "octo on github.com is connected.", details: ["https://github.com"] });
    expect(forgesLine([forge("https://git.example.com", null)])).toEqual({ reason: "git.example.com is connected.", details: ["https://git.example.com"] });
    expect(forgesLine([forge("https://github.com", "octo"), forge("https://git.example.com", "dev")])).toEqual({
      reason: "2 forges connected.",
      details: ["https://github.com", "https://git.example.com"],
    });
    expect(forgesLine([])).toBeUndefined();
  });

  it("names the one key manager connected, or counts them", () => {
    expect(keyManagersLine([{ label: "Vault" }])).toEqual({ reason: "Connected to Vault." });
    expect(keyManagersLine([{ label: "Vault" }, { label: "Doppler" }])).toEqual({ reason: "2 key managers connected.", details: ["Vault", "Doppler"] });
    expect(keyManagersLine([])).toBeUndefined();
  });

  it("says the one notebook in use is ready, or counts them, each notebook's name in details", () => {
    expect(notebooksLine([{ name: "personal", enabled: true }, { name: "old", enabled: false }])).toEqual({ reason: "Your notebook is ready.", details: ["personal"] });
    expect(notebooksLine([{ name: "personal", enabled: true }, { name: "team", enabled: true }])).toEqual({ reason: "Your 2 notebooks are ready.", details: ["personal", "team"] });
    expect(notebooksLine([{ name: "old", enabled: false }])).toBeUndefined();
  });
});
