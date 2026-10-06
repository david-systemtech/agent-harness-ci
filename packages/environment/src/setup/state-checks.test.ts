import { presetSettings, type EnvironmentStatus } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { yourMachinesLine } from "./state-checks.js";

/**
 * Your machines' line when done (#1698): one sentence of what was found, the
 * version it runs, its updates and where it can be reached, never the
 * conditions of its seven checks.
 */

const ready: EnvironmentStatus = {
  readiness: "ready",
  activity: { state: "idle" },
  updatesManagedOutside: false,
  binding: { tailnet: null, lan: null, lanAddresses: [] },
};

describe("Your machines' line when done", () => {
  it("names the version it is ready on, whether updates are on, off, pinned or the host's, and where it is reachable", () => {
    const values = presetSettings();
    expect(yourMachinesLine("0.1.3", ready, values)).toBe("Ready on 0.1.3, updates on, reachable from this machine only.");
    expect(yourMachinesLine("0.1.3", ready, { ...values, "updates.autoUpdate": false })).toBe("Ready on 0.1.3, updates off, reachable from this machine only.");
    expect(yourMachinesLine("0.1.3", ready, { ...values, "updates.pinnedVersion": "0.1.2" })).toBe("Ready on 0.1.3, updates pinned to 0.1.2, reachable from this machine only.");
    expect(yourMachinesLine("0.1.3", { ...ready, updatesManagedOutside: true }, values)).toBe("Ready on 0.1.3, updates by the host, reachable from this machine only.");

    const tailnet = { address: "100.64.0.7", name: "desk.tail0000.ts.net" };
    expect(yourMachinesLine("0.1.3", { ...ready, binding: { tailnet, lan: null, lanAddresses: [] } }, values)).toBe("Ready on 0.1.3, updates on, reachable on the tailnet.");
    expect(yourMachinesLine("0.1.3", { ...ready, binding: { tailnet, lan: "192.168.1.20", lanAddresses: ["192.168.1.20"] } }, values)).toBe(
      "Ready on 0.1.3, updates on, reachable on the tailnet and the LAN.",
    );
    expect(yourMachinesLine("0.1.3", { ...ready, activity: { state: "draining", drainingSince: "2026-10-06T08:00:00.000Z" } }, values)).toBe(
      "Restarting on 0.1.3, updates on, reachable from this machine only.",
    );
  });

  it("says no alternative taken from the checks' conditions", () => {
    expect(yourMachinesLine("0.1.3", ready, presetSettings())).not.toMatch(/\bor\b/);
  });
});
