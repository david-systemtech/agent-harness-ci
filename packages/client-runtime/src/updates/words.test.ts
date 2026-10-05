import type { PendingUpdate } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { bundledServerWords, drainableUpdate, offersClientVersion, pendingUpdateWords } from "./words.js";

/**
 * What the update controls say of a pending update, when a client offers
 * its own version, and which update Drain and update now takes
 * (launcher-update spec, "Settings, methods, notices and flags"; #424,
 * #825), for the states the GUI's tests do not reach.
 */

const NOW = new Date("2026-09-24T00:00:00.000Z");

const PENDING = {
  updateId: "0199aa00-0000-4000-8000-00000000000a",
  toVersion: "0.6.0",
  source: "channel",
  since: "2026-09-24T00:00:00.000Z",
  deferUntil: "2026-09-25T00:00:00.000Z",
  image: null,
} as const;

describe("a pending update in words", () => {
  it.each<[PendingUpdate, string | null]>([
    [{ state: "current" }, null],
    [{ state: "waiting", ...PENDING, waitsOn: null }, "Updating to 0.6.0 within a minute: nothing holds it."],
    [{ state: "ready", ...PENDING }, "0.6.0 is ready: it waits for the host-side updater."],
    [{ state: "switching", ...PENDING, cause: "idle" }, "Switching to 0.6.0."],
  ])("%j", (pending, words) => {
    expect(pendingUpdateWords(pending, "desk", NOW)).toBe(words);
  });
});

describe("the offer of this client's version", () => {
  it("is made to an environment running an older release, and not to one running the same or a newer one", () => {
    expect(offersClientVersion("0.6.0", "0.5.0", { state: "current" })).toBe(true);
    expect(offersClientVersion("0.6.0", "0.6.0", { state: "current" })).toBe(false);
    expect(offersClientVersion("0.6.0", "0.7.0-beta.1", null)).toBe(false);
    expect(offersClientVersion("0.6.0-beta.2", "0.6.0-beta.1", null)).toBe(true);
  });

  it("is made while an update under way goes to an older version than this client's, and not once one goes as far", () => {
    expect(offersClientVersion("0.6.0", "0.5.0", { state: "waiting", ...PENDING, toVersion: "0.5.1", waitsOn: null })).toBe(true);
    expect(offersClientVersion("0.6.0", "0.5.0", { state: "draining", ...PENDING, cause: "requested" })).toBe(false);
    expect(offersClientVersion("0.6.0", "0.5.0", { state: "blocked", reason: "launcher", toVersion: "0.6.0", message: "It needs a newer launcher." })).toBe(true);
  });

  it("is never made when either version is no release version", () => {
    expect(offersClientVersion("dev", "0.5.0", null)).toBe(false);
    expect(offersClientVersion("0.6.0", "a checkout", null)).toBe(false);
  });
});

describe("the update Drain and update now takes", () => {
  it("is a waiting update busy work holds, and none in any other state", () => {
    const held: PendingUpdate = { state: "waiting", ...PENDING, waitsOn: { reason: "terminal-running", until: null } };
    expect(drainableUpdate(held)).toBe(held);
    expect(drainableUpdate({ state: "waiting", ...PENDING, waitsOn: null })).toBeNull();
    expect(drainableUpdate({ state: "current" })).toBeNull();
    expect(drainableUpdate({ state: "staging", updateId: PENDING.updateId, toVersion: "0.6.0", source: "request" })).toBeNull();
    expect(drainableUpdate({ state: "ready", ...PENDING })).toBeNull();
    expect(drainableUpdate({ state: "draining", ...PENDING, cause: "requested" })).toBeNull();
    expect(drainableUpdate({ state: "switching", ...PENDING, cause: "requested" })).toBeNull();
    expect(drainableUpdate({ state: "blocked", reason: "launcher", toVersion: "0.6.0", message: "It needs a newer launcher." })).toBeNull();
  });
});

it("describes a bundled install refusal without attributing it to an environment that may never have been asked", () => {
  expect(bundledServerWords({ state: "failed", version: "0.6.0", reason: "disk", message: "Free space and retry." }, "desk"))
    .toBe("Could not install the bundled 0.6.0 for desk: Free space and retry.");
});
