import type { Scope } from "@agent-harness/contracts";
import { useCleanups } from "../../environment/test/cleanups.js";
import type { PairingOutcome } from "../src/pairing.js";
import { createRuntimeWithSeams } from "../src/internal.js";
import type { Shell } from "../src/shell.js";
import { fakeWire, type FakeWire } from "../src/testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../src/testing/in-memory-platform.js";
import { subscription, type Scripted } from "./scripted.js";

/**
 * A runtime paired over the fake wire with scripted environments, for the
 * suites of the runtime's parts that follow an environment's own stream:
 * the forge's (#320) and the key managers' (#384).
 */

/** Throws unless the connection was paired. */
const assertPaired = (result: PairingOutcome): void => {
  if (result.status !== "paired") throw new Error(`The runtime did not pair with the fake environment: ${JSON.stringify(result)}`);
};

/**
 * A runtime paired with one scripted environment named `desk` offering
 * `capabilities`, its environment stream synchronized and held by the test,
 * on a desktop's platform with `shell` when one is given.
 */
const pairedWith = (onCleanup: (cleanup: () => Promise<void>) => void) => async (options: { readonly capabilities: readonly string[]; readonly shell?: Shell }) => {
  const clock = manualClock();
  const wire: FakeWire = fakeWire({ clock, name: "desk", capabilities: [...options.capabilities] });
  wire.answer("sessions.subscribe", () => undefined);
  wire.answer("environment.subscribe", () => undefined);
  const secrets = new Map<string, string>();
  const platform = inMemoryPlatform({
    clock,
    fetch: wire.fetch,
    webSocket: wire.webSocket,
    secrets: { get: async (name) => secrets.get(name), set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) },
    ...(options.shell !== undefined && { kind: "desktop", label: "David's laptop", shell: options.shell }),
  });
  const { runtime } = createRuntimeWithSeams(platform);
  onCleanup(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  (await subscription(wire, "sessions.subscribe")).synchronized(0);
  const environment: Scripted = await subscription(wire, "environment.subscribe");
  environment.synchronized(0);
  assertPaired(await adding);
  /** Everything this client keeps: its documents and its secrets, as text, to look for a secret in. */
  const kept = () => JSON.stringify({ documents: platform.documents.entries(), secrets: [...secrets.values()] });
  return { clock, wire, platform, runtime, env: wire.environmentId, environment, kept };
};

/** A runtime paired with a scripted environment per entry, each offering `capabilities` and granting its scopes (every scope when absent). */
const pairedManyWith = (onCleanup: (cleanup: () => Promise<void>) => void) => async (capabilities: readonly string[], environments: readonly { readonly name: string; readonly scopes?: readonly Scope[] }[]) => {
  const clock = manualClock();
  const wires = environments.map(({ name }, index) => fakeWire({ clock, name, capabilities: [...capabilities], address: { host: `env-${index}.test`, port: 7433 } }));
  const route = (url: string) => wires.find((_, index) => url.includes(`env-${index}.test`)) ?? (wires[0] as FakeWire);
  const platform = inMemoryPlatform({ clock, fetch: (url, request) => route(url).fetch(url, request), webSocket: (url, handlers) => route(url).webSocket(url, handlers) });
  const { runtime } = createRuntimeWithSeams(platform);
  onCleanup(() => runtime.close());
  await runtime.start();
  for (const [index, wire] of wires.entries()) {
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    const adding = runtime.connections.add({ link: wire.link });
    const scopes = environments[index]?.scopes;
    await wire.server.accept(scopes === undefined ? {} : { scopes: [...scopes] });
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    (await subscription(wire, "environment.subscribe")).synchronized(0);
    assertPaired(await adding);
  }
  return { clock, runtime, platform, wires, ids: wires.map((wire) => wire.environmentId) };
};

/** The helpers above, each runtime closed after its test. Call once at the top of a test file. */
export const usePaired = () => {
  const { onCleanup } = useCleanups();
  return { paired: pairedWith(onCleanup), pairedMany: pairedManyWith(onCleanup) };
};
