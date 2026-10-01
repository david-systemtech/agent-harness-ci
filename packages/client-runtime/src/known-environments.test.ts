import type { RequestFrame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { noticeEvent } from "../test/events.js";
import { subscription, type Scripted } from "../test/scripted.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { RuntimeClientKind } from "./platform.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * The known-environments report in the client runtime (key-managers spec,
 * "Modules" and "The orientation block"; #382), through the fake wire: when
 * a desktop's or terminal UI's runtime tells each environment it connects to
 * of its other connections, and what it tells it. A browser tab's runtime
 * tells none; a program has no runtime.
 */

const { onCleanup } = useCleanups();

const REPORT = "environment.knownEnvironments.report";

/** A runtime of `kind` paired with a scripted environment per name, each ready, its own stream held by the test. */
const pairedWith = async (kind: RuntimeClientKind, names: readonly string[]) => {
  const clock = manualClock();
  const wires = names.map((name, index) => fakeWire({ clock, name, address: { host: `env-${index}.test`, port: 7433 } }));
  const route = (url: string) => wires.find((_, index) => url.includes(`env-${index}.test`)) ?? (wires[0] as FakeWire);
  const platform = inMemoryPlatform({ clock, kind, fetch: (url, request) => route(url).fetch(url, request), webSocket: (url, handlers) => route(url).webSocket(url, handlers) });
  const { runtime } = createRuntimeWithSeams(platform);
  onCleanup(() => runtime.close());
  await runtime.start();
  const streams: Scripted[] = [];
  for (const wire of wires) {
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    wire.answer(REPORT, () => ({ result: {} }));
    streams.push(await ready(wire, runtime.connections.add({ link: wire.link })));
  }
  return { clock, runtime, wires, ids: wires.map((wire) => wire.environmentId), streams };
};

/** Accepts the socket the client opens next, answers its two subscriptions, and waits for what brought it to settle: its own stream's script. */
const ready = async (wire: FakeWire, settling: Promise<unknown>): Promise<Scripted> => {
  await wire.server.accept();
  (await subscription(wire, "sessions.subscribe")).synchronized(0);
  const stream = await subscription(wire, "environment.subscribe");
  stream.synchronized(0);
  await settling;
  return stream;
};

/** Every report the environment has had from the client on its latest socket, in order: each one's environments. */
const reports = (wire: FakeWire) => wire.server.received().flatMap((frame) => (frame.type === "request" && frame.method === REPORT ? [(frame as RequestFrame).params["environments"]] : []));

/** One of the client's connections as a report names it. */
const named = (wire: FakeWire, name: string, address = wire.origin) => ({ id: wire.environmentId, name, address });

describe("a desktop's runtime", () => {
  it("tells each environment, once it is ready, of every other connection it holds, by id, name and address, and again as each is added", async () => {
    const { wires } = await pairedWith("desktop", ["desk", "laptop", "server"]);
    const [desk, laptop, server] = wires as [FakeWire, FakeWire, FakeWire];

    expect(reports(desk)).toEqual([[], [named(laptop, "laptop")], [named(laptop, "laptop"), named(server, "server")]]);
    expect(reports(laptop)).toEqual([[named(desk, "desk")], [named(desk, "desk"), named(server, "server")]]);
    expect(reports(server)).toEqual([[named(desk, "desk"), named(laptop, "laptop")]]);
  });

  it("tells them again when a connection is renamed, moved to another address or removed, and not when one is disabled", async () => {
    const { runtime, wires, ids, streams } = await pairedWith("desktop", ["desk", "laptop", "server"]);
    const [desk, laptop, server] = wires as [FakeWire, FakeWire, FakeWire];
    const [deskId, laptopId, serverId] = ids as [string, string, string];
    const before = [reports(desk).length, reports(laptop).length, reports(server).length];

    streams[1]?.event(noticeEvent(1, laptopId, "environment.renamed", { name: "Laptop" }));
    await flush();
    expect(reports(desk).slice(before[0])).toEqual([[named(laptop, "Laptop"), named(server, "server")]]);
    expect(reports(server).slice(before[2])).toEqual([[named(desk, "desk"), named(laptop, "Laptop")]]);
    expect(reports(laptop).slice(before[1])).toEqual([]);

    await runtime.connections.setEnabled(serverId, false);
    await flush();
    expect(runtime.connections.list.read().find((record) => record.environmentId === serverId)?.phase).toBe("disabled");
    expect(reports(desk).slice(before[0])).toHaveLength(1);

    await runtime.connections.setAddress(serverId, "http://server.tail1234.ts.net:7433");
    await flush();
    expect(reports(desk).at(-1)).toEqual([named(laptop, "Laptop"), named(server, "server", "http://server.tail1234.ts.net:7433")]);

    await runtime.connections.remove(laptopId);
    await flush();
    expect(reports(desk).at(-1)).toEqual([named(server, "server", "http://server.tail1234.ts.net:7433")]);
    expect(runtime.connections.list.read().map((record) => record.environmentId)).toEqual([deskId, serverId]);
  });

  it("tells an environment again after each hello, since it may have restarted and forgotten, and the others not again", async () => {
    const { runtime, wires, ids } = await pairedWith("desktop", ["desk", "laptop"]);
    const [desk, laptop] = wires as [FakeWire, FakeWire];
    const opened = desk.opened();
    const toLaptop = reports(laptop).length;

    desk.server.drop();
    await flush();
    await ready(desk, runtime.connections.retryNow(ids[0] as string));

    expect(desk.opened()).toBe(opened + 1);
    expect(reports(desk)).toEqual([[named(laptop, "laptop")]]);
    expect(reports(laptop)).toHaveLength(toLaptop);
  });
});

describe("a terminal UI's runtime", () => {
  it("tells each environment of its other connections as a desktop's does", async () => {
    const { wires } = await pairedWith("tui", ["desk", "laptop"]);
    const [desk, laptop] = wires as [FakeWire, FakeWire];
    expect(reports(desk).at(-1)).toEqual([named(laptop, "laptop")]);
    expect(reports(laptop).at(-1)).toEqual([named(desk, "desk")]);
  });
});

describe("a browser tab's runtime", () => {
  it("tells no environment of its other connections", async () => {
    const { wires } = await pairedWith("web", ["desk", "laptop"]);
    for (const wire of wires) expect(reports(wire)).toEqual([]);
  });
});
