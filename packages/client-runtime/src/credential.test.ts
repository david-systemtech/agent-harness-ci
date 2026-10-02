import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntime } from "./runtime.js";
import { inMemoryPlatform, manualClock, type InMemoryPlatform } from "./testing/in-memory-platform.js";
import { scriptedWorld, type ScriptedWorld } from "./testing/scripted-environment.js";

/**
 * `connections.credential` (#1178): what a caller outside the socket, the
 * terminal UI's screenless printing (ADR 0015's completions), authenticates
 * with as this client: the connection's address and the token its client
 * session holds, from the stores the connection already keeps (a local
 * connection's token in memory from the grant exchange, a paired one's in
 * secret storage). No other credential is minted or kept.
 */

const world = (): { readonly clock: ReturnType<typeof manualClock>; readonly world: ScriptedWorld } => {
  const clock = manualClock();
  return { clock, world: scriptedWorld(clock, { environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] }) };
};

const started = async (platform: InMemoryPlatform) => {
  const runtime = createRuntime(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  return runtime;
};

describe("a connection's credential", () => {
  it("is a local connection's address and the token its grant exchange gave, kept in memory and never in secret storage", async () => {
    const { clock, world: scripted } = world();
    const platform = inMemoryPlatform({ clock, fetch: scripted.fetch, webSocket: scripted.webSocket, grant: scripted.grant });
    const runtime = await started(platform);
    const desk = scripted.environment("desk");

    const credential = await runtime.connections.credential(desk.environmentId);

    expect(credential).toEqual({ origin: desk.wire.origin, token: desk.wire.credential()?.token });
    expect(credential?.token).toEqual(expect.any(String));
    expect(await platform.secrets.get(desk.environmentId)).toBeUndefined();
  });

  it("is a paired connection's address and the token pairing kept in secret storage, read again by a later runtime on the same stores", async () => {
    const { clock, world: scripted } = world();
    const first = inMemoryPlatform({ clock, fetch: scripted.fetch, webSocket: scripted.webSocket });
    const laptop = scripted.environment("laptop");
    const pairing = await started(first);
    expect(await pairing.connections.add({ link: laptop.wire.link })).toMatchObject({ status: "paired" });
    const paired = laptop.wire.credential()?.token;
    await pairing.close();

    const later = inMemoryPlatform({ clock, fetch: scripted.fetch, webSocket: scripted.webSocket, documents: first.documents, secrets: first.secrets });
    const runtime = createRuntime(later);
    onTestFinished(() => runtime.close());

    // Read before any start, from what was saved: nothing is exchanged or paired again.
    expect(await runtime.connections.credential(laptop.environmentId)).toEqual({ origin: laptop.wire.origin, token: paired });
    expect(laptop.wire.credential()?.token).toBe(paired);
  });

  it("is none for an environment the client holds no connection to", async () => {
    const { clock, world: scripted } = world();
    const runtime = await started(inMemoryPlatform({ clock, fetch: scripted.fetch, webSocket: scripted.webSocket }));

    expect(await runtime.connections.credential(scripted.environment("laptop").environmentId)).toBeUndefined();
  });
});
