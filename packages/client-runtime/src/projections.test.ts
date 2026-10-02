import { Ceiling, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { HARNESS_VERSION } from "../../environment/src/serve/start.js";
import { TOP_CEILING } from "../../environment/src/auth/client-sessions.js";
import { presetColour } from "../../environment/src/look/look.js";
import { grantReader, useHarness } from "../test/harness.js";
import { LOCAL_PLACEHOLDER_ID } from "./connections/records.js";
import { homeEnvironment, type EnvironmentView } from "./projections/environments.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

describe("projections.environments", () => {
  it("lists each known environment in the saved sequence with its descriptor, scopes, ceiling and the primary mark", async () => {
    const local = await harness.environment({ name: "desk", platform: "darwin" });
    const paired = await harness.environment({ name: "tower", platform: "linux" });
    const runtime = harness.runtime(inMemoryPlatform({ kind: "tui", grant: grantReader(local) }));
    await runtime.start();
    const seen: unknown[] = [];
    runtime.projections.environments.subscribe((value) => seen.push(value));
    await runtime.connections.add({ link: (await paired.createPairing({ scopes: ["read"], ceiling: Ceiling.parse("plan") })).link });

    expect(runtime.projections.environments.read()).toEqual([
      {
        environmentId: local.env.id,
        kind: "local",
        primary: true,
        name: "desk",
        icon: "laptop",
        colour: presetColour(local.env.id),
        version: HARNESS_VERSION,
        flags: ["forge", "keyManagers", "managedTools", "workspaceChecks", "banks", "setup", "stateImport"],
        scopes: [...SCOPES],
        ceiling: TOP_CEILING,
        enabled: true,
        phase: "ready",
        blocked: null,
        retryAt: null,
        unreachableSince: null,
        refreshFailed: null,
        action: null,
        pendingCommands: 0,
      },
      expect.objectContaining({ environmentId: paired.env.id, kind: "paired", primary: false, name: "tower", icon: "server", colour: presetColour(paired.env.id), scopes: ["read"], ceiling: "plan" }),
    ]);
    expect(seen.length).toBeGreaterThan(0);

    await runtime.connections.setOrder([paired.env.id, local.env.id]);
    expect(runtime.projections.environments.read().map((e) => [e.name, e.primary])).toEqual([
      ["tower", true],
      ["desk", false],
    ]);
  });

  it("reads the same value until something changes", async () => {
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    expect(runtime.projections.environments.read()).toBe(runtime.projections.environments.read());
  });
});

describe("the home environment", () => {
  /** An environment as the projection lists it: ready, with every scope, differing only in its id, kind and place. */
  const listed = (environmentId: string, kind: EnvironmentView["kind"], primary: boolean): EnvironmentView => ({
    environmentId,
    kind,
    primary,
    name: environmentId,
    icon: null,
    colour: null,
    version: HARNESS_VERSION,
    flags: [],
    scopes: [...SCOPES],
    ceiling: TOP_CEILING,
    enabled: true,
    phase: "ready",
    blocked: null,
    retryAt: null,
    unreachableSince: null,
    refreshFailed: null,
    action: null,
    pendingCommands: 0,
  });

  it("is the local environment wherever it stands in the sequence, whatever its phase, else the primary, and none while none is known", () => {
    const tower = listed("tower", "paired", true);
    const desk = listed("desk", "local", false);
    expect(homeEnvironment([tower, desk])).toBe(desk);
    expect(homeEnvironment([tower, { ...desk, phase: "service-down", enabled: false }])?.environmentId).toBe("desk");
    expect(homeEnvironment([tower, listed("mnl", "paired", false)])).toBe(tower);
    expect(homeEnvironment([])).toBeUndefined();
  });

  it("is never the placeholder for a local environment that has not answered yet: the first other in the sequence is, or none", () => {
    const placeholder = { ...listed(LOCAL_PLACEHOLDER_ID, "local", true), name: null, phase: "service-down" as const };
    const tower = listed("tower", "paired", false);
    expect(homeEnvironment([placeholder, tower])).toBe(tower);
    expect(homeEnvironment([placeholder])).toBeUndefined();
  });
});
