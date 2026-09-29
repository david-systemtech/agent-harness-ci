import { describe, expect, it } from "vitest";
import {
  DiscoveryDocument,
  ENVIRONMENT_COLOURS,
  ENVIRONMENT_ICONS,
  EnvironmentColour,
  EnvironmentIcon,
  EnvironmentLook,
  EnvironmentName,
  EnvironmentNotice,
  HelloFrame,
  decodeFrame,
  normaliseEnvironmentName,
  registry,
} from "./index.js";
import { validDiscovery, validFrames } from "../test/fixtures.js";

/**
 * An environment's name, icon and colour (workspace-picker spec, "Name,
 * icon and colour"; ADR 0025): the rules a value is held to, the three
 * commands and notices that set them, and where a client reads them.
 */

describe("an environment's look", () => {
  it("takes an icon from ADR 0025's ten and a colour from the twelve names, both closed sets and never a literal", () => {
    expect(ENVIRONMENT_ICONS).toEqual(["laptop", "desktop", "server", "nas", "cloud", "container", "board", "home", "office", "lab"]);
    expect(ENVIRONMENT_COLOURS).toEqual(["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"]);
    for (const icon of ENVIRONMENT_ICONS) expect(EnvironmentIcon.safeParse(icon).success, icon).toBe(true);
    for (const bad of ["Laptop", "phone", "💻", "", null]) expect(EnvironmentIcon.safeParse(bad).success, String(bad)).toBe(false);
    for (const bad of ["#ff8800", "rgb(255, 136, 0)", "Red", "magenta", ""]) expect(EnvironmentColour.safeParse(bad).success, bad).toBe(false);
  });

  it("takes a name of 1 to 40 code points once trimmed, with no control or format character but white space, as a group's name is held", () => {
    for (const good of ["MNL", "x".repeat(40), ` ${"x".repeat(40)} `, "🖥".repeat(40), "David's laptop", "a\tb"]) {
      expect(EnvironmentName.safeParse(good).success, JSON.stringify(good)).toBe(true);
    }
    for (const bad of ["", "   ", "x".repeat(41), "🖥".repeat(41), "a\u0000b", "a\u200bb", "\u200b", "a\u2066b"]) {
      expect(EnvironmentName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(normaliseEnvironmentName("  SYSTEM \t SERVER\n ")).toBe("SYSTEM SERVER");
  });

  it("is a name, an icon and a colour, where a name is any the record holds: one it was created with may be longer than a rename takes", () => {
    const look = { name: "MNL", icon: "server", colour: "teal" };
    expect(EnvironmentLook.parse(look)).toEqual(look);
    expect(EnvironmentLook.safeParse({ ...look, name: "a-hostname-label-longer-than-forty-code-points" }).success).toBe(true);
    for (const bad of [{ ...look, name: "" }, { ...look, icon: "phone" }, { ...look, colour: "#008080" }, { name: "MNL", icon: "server" }]) {
      expect(EnvironmentLook.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is set by three admin commands, one per field, each answering the look as it now is", () => {
    const look = { name: "MNL", icon: "server", colour: "teal" };
    const commandId = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
    const cases = [
      ["environment.rename", { name: " MNL " }, { name: "" }],
      ["environment.setIcon", { icon: "nas" }, { icon: "phone" }],
      ["environment.setColour", { colour: "amber" }, { colour: "#ffbf00" }],
    ] as const;
    for (const [name, good, bad] of cases) {
      const method = registry[name];
      expect([method.kind, method.scope], name).toEqual(["command", "admin"]);
      expect(method.params.safeParse({ commandId, ...good }).success, name).toBe(true);
      expect(method.params.safeParse({ commandId, ...bad }).success, name).toBe(false);
      expect(method.params.safeParse(good).success, `${name} without a commandId`).toBe(false);
      expect(method.result.parse(look), name).toEqual(look);
    }
  });

  it("changes by three notices on the environment stream, which environment.subscribe's snapshot is the look after", () => {
    const notice = (type: string, payload: Record<string, unknown>) => EnvironmentNotice.safeParse({ type, payload });
    expect(notice("environment.renamed", { name: "MNL" }).data).toEqual({ type: "environment.renamed", payload: { name: "MNL" } });
    expect(notice("environment.icon-set", { icon: "nas" }).data).toEqual({ type: "environment.icon-set", payload: { icon: "nas" } });
    expect(notice("environment.colour-set", { colour: "amber" }).data).toEqual({ type: "environment.colour-set", payload: { colour: "amber" } });
    for (const [type, payload] of [
      ["environment.renamed", { name: "" }],
      ["environment.icon-set", { icon: "phone" }],
      ["environment.colour-set", { colour: "#ffbf00" }],
    ] as const) {
      expect(notice(type, payload).success, type).toBe(false);
    }

    const snapshot = registry["environment.subscribe"].result;
    const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false };
    const environment = { name: "MNL", icon: "server", colour: "teal" };
    expect(snapshot.parse({ status, environment })).toEqual({ status, environment });
    // An environment from before the look sends none, and a client still reads its snapshot.
    expect(snapshot.parse({ status })).toEqual({ status });
    expect(snapshot.safeParse({ status, environment: { ...environment, colour: "#008080" } }).success).toBe(false);
  });

  it("travels in discovery and hello as optional fields, so a client of either age reads the other with no protocol bump", () => {
    const withLook = { ...validDiscovery, environmentIcon: "nas", environmentColour: "amber" };
    expect(DiscoveryDocument.parse(withLook)).toEqual(withLook);
    expect(DiscoveryDocument.parse(validDiscovery)).toEqual(validDiscovery);

    const hello = validFrames.hello[0] as Record<string, unknown>;
    expect(HelloFrame.parse({ ...hello, environmentIcon: "laptop", environmentColour: "pink" })).toMatchObject({ environmentIcon: "laptop", environmentColour: "pink" });
    expect(HelloFrame.parse(hello)).not.toHaveProperty("environmentIcon");
  });

  it("reads an icon or colour this build does not know (a newer environment's) as none in discovery and hello, and the rest of either still reads", () => {
    const discovered = DiscoveryDocument.parse({ ...validDiscovery, environmentIcon: "phone", environmentColour: "#ffbf00" });
    expect(discovered).toMatchObject({ environmentId: validDiscovery.environmentId, environmentName: validDiscovery.environmentName });
    expect([discovered.environmentIcon, discovered.environmentColour]).toEqual([undefined, undefined]);
    const hello = HelloFrame.parse({ ...(validFrames.hello[0] as Record<string, unknown>), environmentIcon: "phone", environmentColour: "magenta" });
    expect([hello.environmentName, hello.environmentIcon, hello.environmentColour]).toEqual(["SYSTEM-SERVER", undefined, undefined]);
    expect(decodeFrame(JSON.stringify({ ...(validFrames.hello[0] as Record<string, unknown>), environmentIcon: "phone" }))).toMatchObject({ type: "hello", environmentName: "SYSTEM-SERVER" });
    // The environment's own writes stay held to the sets: the commands' params and the notices refuse either.
    expect(registry["environment.setIcon"].params.safeParse({ commandId: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", icon: "phone" }).success).toBe(false);
  });
});
