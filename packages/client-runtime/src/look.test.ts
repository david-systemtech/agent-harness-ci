import type { EnvironmentColour, EnvironmentIcon } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { noticeEvent } from "../test/events.js";
import { subscription } from "../test/scripted.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { inMemoryDocuments, inMemoryPlatform, manualClock, type InMemoryDocumentStore, type ManualClock } from "./testing/in-memory-platform.js";

/**
 * An environment's name, icon and colour in the connection descriptor
 * (workspace-picker spec, "Name, icon and colour"; #323), against the
 * scripted fake wire: read from discovery and `hello`, then from
 * `environment.subscribe`'s snapshot and its three notices, so
 * `projections.environments` carries them to every renderer, and no notice
 * says so. What is asserted is what a renderer reads.
 */

interface Look {
  readonly name?: string;
  readonly icon?: EnvironmentIcon;
  readonly colour?: EnvironmentColour;
}

/** A runtime on a fake environment of `look`, its streams left for the test to answer. */
const runtimeOn = (look: Look, setup: { readonly clock?: ManualClock; readonly documents?: InMemoryDocumentStore; readonly environmentId?: string } = {}) => {
  const clock = setup.clock ?? manualClock();
  const wire: FakeWire = fakeWire({ clock, name: look.name ?? "desk", ...(look.icon && { icon: look.icon }), ...(look.colour && { colour: look.colour }), ...(setup.environmentId && { environmentId: setup.environmentId }) });
  for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
  const documents = setup.documents ?? inMemoryDocuments();
  const { runtime } = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, documents }));
  onTestFinished(() => runtime.close());
  return { clock, wire, runtime, documents };
};

/** Paired and ready, the session list synchronized empty; the environment's stream subscribed and left to the test. */
const paired = async (look: Look) => {
  const s = runtimeOn(look);
  await s.runtime.start();
  const adding = s.runtime.connections.add({ link: s.wire.link });
  await s.wire.server.accept();
  (await subscription(s.wire, "sessions.subscribe")).synchronized(0);
  const environment = await subscription(s.wire, "environment.subscribe");
  await adding;
  return { ...s, environment };
};

/** What `projections.environments` shows of the one environment's look. */
const shown = (runtime: Runtime) => {
  const [view] = runtime.projections.environments.read();
  return { name: view?.name, icon: view?.icon, colour: view?.colour };
};

describe("the connection descriptor's name, icon and colour", () => {
  it("are read from discovery and hello, and projections.environments shows them", async () => {
    const { runtime } = await paired({ name: "MNL", icon: "server", colour: "teal" });
    expect(shown(runtime)).toEqual({ name: "MNL", icon: "server", colour: "teal" });
  });

  it("are null for an environment that sends no icon or colour, one from before them", async () => {
    const { runtime } = await paired({ name: "old" });
    expect(shown(runtime)).toEqual({ name: "old", icon: null, colour: null });
  });

  it("take what hello says over the discovery read before it", async () => {
    const s = runtimeOn({ name: "MNL", icon: "server", colour: "teal" });
    await s.runtime.start();
    const adding = s.runtime.connections.add({ link: s.wire.link });
    await s.wire.server.accept({ environmentName: "MNL box", environmentIcon: "nas", environmentColour: "amber" });
    (await subscription(s.wire, "sessions.subscribe")).synchronized(0);
    await adding;
    expect(shown(s.runtime)).toEqual({ name: "MNL box", icon: "nas", colour: "amber" });
  });

  it("follow environment.subscribe's snapshot", async () => {
    const { runtime, environment } = await paired({ name: "MNL", icon: "server", colour: "teal" });
    environment.snapshot(12, {
      status: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false },
      environment: { name: "SYSTEM-SERVER", icon: "lab", colour: "lime" },
    });
    environment.synchronized(12);
    await flush();
    expect(shown(runtime)).toEqual({ name: "SYSTEM-SERVER", icon: "lab", colour: "lime" });
  });

  it("take a rename, an icon and a colour another client set, live, with no notice", async () => {
    const { runtime, wire, environment } = await paired({ name: "MNL", icon: "server", colour: "teal" });
    environment.synchronized(4);
    await flush();
    const seen: unknown[] = [];
    runtime.projections.environments.subscribe((views) => seen.push(views[0]?.name));

    environment.event(noticeEvent(5, wire.environmentId, "environment.renamed", { name: "MNL box" }));
    await flush();
    expect(shown(runtime)).toEqual({ name: "MNL box", icon: "server", colour: "teal" });
    environment.event(noticeEvent(6, wire.environmentId, "environment.icon-set", { icon: "nas" }));
    environment.event(noticeEvent(7, wire.environmentId, "environment.colour-set", { colour: "amber" }));
    await flush();
    expect(shown(runtime)).toEqual({ name: "MNL box", icon: "nas", colour: "amber" });
    expect(seen).toContain("MNL box");
    expect(runtime.projections.notices.read()).toEqual([]);
  });

  it("settle on the latest of a replay: notices heard as history move it no further than where the environment stands", async () => {
    const { runtime, wire, environment } = await paired({ name: "third", icon: "cloud", colour: "pink" });
    environment.event(noticeEvent(1, wire.environmentId, "environment.renamed", { name: "first" }));
    environment.event(noticeEvent(2, wire.environmentId, "environment.icon-set", { icon: "lab" }));
    environment.event(noticeEvent(3, wire.environmentId, "environment.renamed", { name: "second" }));
    environment.event(noticeEvent(4, wire.environmentId, "environment.icon-set", { icon: "cloud" }));
    environment.event(noticeEvent(5, wire.environmentId, "environment.renamed", { name: "third" }));
    environment.synchronized(5);
    await flush();
    expect(shown(runtime)).toEqual({ name: "third", icon: "cloud", colour: "pink" });
    expect(runtime.projections.notices.read()).toEqual([]);
  });

  it("are saved with the connection, so the next start shows them before any socket", async () => {
    const first = await paired({ name: "MNL", icon: "server", colour: "teal" });
    first.environment.synchronized(0);
    first.environment.event(noticeEvent(1, first.wire.environmentId, "environment.renamed", { name: "MNL box" }));
    first.environment.event(noticeEvent(2, first.wire.environmentId, "environment.colour-set", { colour: "violet" }));
    await flush();
    await first.runtime.close();

    const second = runtimeOn({ name: "MNL box", icon: "server", colour: "violet" }, { clock: first.clock, documents: first.documents, environmentId: first.wire.environmentId });
    second.wire.discovery("unreachable");
    void second.runtime.start();
    await flush();
    expect(shown(second.runtime)).toEqual({ name: "MNL box", icon: "server", colour: "violet" });
  });
});
