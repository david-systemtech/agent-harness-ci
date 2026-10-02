import { expect } from "vitest";
import { createRuntime } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock, type InMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";

/**
 * This machine's terminal as the screenless entry finds it (#1178, #1180):
 * the in-memory platform over the scripted environments, the local one
 * through its grant file and each `paired` one paired once before, as
 * `/pair` saves it, so a later invocation chooses on what was saved.
 */
export interface Machine {
  readonly world: ScriptedWorld;
  readonly platform: InMemoryPlatform;
}

export const machine = async (script: Script): Promise<Machine> => {
  const clock = manualClock();
  const world = scriptedWorld(clock, script);
  const platform = inMemoryPlatform({ clock, fetch: world.fetch, webSocket: world.webSocket, ...(world.grant && { grant: world.grant }) });
  const paired = script.environments.filter((spec) => spec.reach === "paired");
  if (paired.length > 0) {
    const earlier = createRuntime(platform);
    await earlier.start();
    for (const spec of paired) expect(await earlier.connections.add({ link: world.environment(spec.name).wire.link })).toMatchObject({ status: "paired" });
    await earlier.close();
  }
  return { world, platform };
};

/** How many sockets each environment has open, by name. */
export const openSockets = (on: Machine) => on.world.environments.map((environment) => [environment.name, environment.wire.open()]);
/** No environment has a socket open: whatever runtime was started on the machine is closed. */
export const noneOpen = (on: Machine) => on.world.environments.map((environment) => [environment.name, 0]);
