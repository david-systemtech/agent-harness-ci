import { Ceiling, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { HARNESS_VERSION } from "../../environment/src/serve/start.js";
import { TOP_CEILING } from "../../environment/src/auth/client-sessions.js";
import { grantReader, useHarness } from "../test/harness.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

describe("projections.environments", () => {
  it("lists each known environment in the saved sequence with its descriptor, scopes, ceiling and the primary mark", async () => {
    const local = await harness.environment({ name: "desk" });
    const paired = await harness.environment({ name: "tower" });
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
        icon: null,
        colour: null,
        version: HARNESS_VERSION,
        flags: [],
        scopes: [...SCOPES],
        ceiling: TOP_CEILING,
        enabled: true,
        phase: "ready",
        blocked: null,
      },
      expect.objectContaining({ environmentId: paired.env.id, kind: "paired", primary: false, name: "tower", scopes: ["read"], ceiling: "plan" }),
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
