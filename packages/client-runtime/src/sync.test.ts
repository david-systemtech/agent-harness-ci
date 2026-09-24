import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { workspace } from "../../environment/test/sessions.js";
import { until, useHarness } from "../test/harness.js";
import type { ConnectionSeams } from "./connections/registry.js";
import type { Runtime } from "./runtime.js";
import { SESSION_LINGER_MS } from "./streams/session-handles.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * Subscriptions through the in-process environment (docs/specs/client-runtime.md,
 * "Testing Decisions", the primary seam): real sockets, real subscriptions,
 * real commands. The commands go through one runtime's request seam, since
 * the outbox is #128's; what is asserted is what the other runtime's
 * projections show, with no polling anywhere.
 */

const harness = useHarness();

/** Sends a command through a runtime's socket to `environmentId`; throws unless it is accepted. */
const send = async (seams: ConnectionSeams, environmentId: string, method: string, params: Record<string, unknown>) => {
  const response = await seams.request(environmentId, method, { commandId: randomUUID(), ...params });
  const receipt = (response.result as { receipt?: { status: string } } | undefined)?.receipt;
  if (response.error || receipt?.status !== "accepted") throw new Error(`${method} was not accepted: ${JSON.stringify(response)}`);
};

const summary = (runtime: Runtime, id: string) => runtime.projections.sessionList.read().rows.find((row) => row.summary.id === id)?.summary;

describe("two runtimes on one environment", () => {
  it("see each other's archive, pin and group without polling", async () => {
    const t = await harness.environment({ name: "desk" });
    const one = harness.withSeams(inMemoryPlatform());
    const two = harness.withSeams(inMemoryPlatform());
    for (const { runtime } of [one, two]) {
      await runtime.start();
      await runtime.connections.add({ link: (await t.createPairing()).link });
    }
    const env = t.env.id;
    const [archived, pinned, grouped, group] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    for (const id of [archived, pinned, grouped]) await send(one.seams, env, "sessions.create", { id, workspace });
    await until(() => [archived, pinned, grouped].every((id) => summary(two.runtime, id) !== undefined), "the second runtime to list the new sessions");

    await send(one.seams, env, "sessions.archive", { sessionId: archived });
    await send(one.seams, env, "sessions.pin", { sessionId: pinned });
    await send(one.seams, env, "groups.create", { id: group, name: "Brandsolidate" });
    await send(one.seams, env, "sessions.setGroup", { sessionId: grouped, groupId: group });

    await until(() => two.runtime.projections.sessionList.read().groups[0]?.shelves.active.length === 1, "the group to reach the second runtime");
    const view = two.runtime.projections.sessionList.read();
    expect(view.archived.map((r) => r.summary.id)).toEqual([archived]);
    expect(view.pinned.map((r) => r.summary.id)).toEqual([pinned]);
    expect(view.groups).toEqual([
      expect.objectContaining({ name: "Brandsolidate", groups: [{ environmentId: env, groupId: group, name: "Brandsolidate" }] }),
    ]);
    expect(view.groups[0]?.shelves.active.map((r) => r.summary.id)).toEqual([grouped]);
    expect(view.environments).toEqual([{ environmentId: env, freshness: "live", fault: null }]);

    // And back the other way.
    await send(two.seams, env, "sessions.unarchive", { sessionId: archived });
    await until(() => summary(one.runtime, archived)?.archivedAt === null, "the unarchive to reach the first runtime");
  });
});

describe("the list across a restart", () => {
  it("renders from the cache, then cached, catching-up, live", async () => {
    const t = await harness.environment({ name: "desk" });
    const clock = manualClock();
    const platform = inMemoryPlatform({ clock });
    const first = harness.withSeams(platform);
    await first.runtime.start();
    await first.runtime.connections.add({ link: (await t.createPairing()).link });
    const id = randomUUID();
    await send(first.seams, t.env.id, "sessions.create", { id, workspace, title: "Invoices" });
    await until(() => summary(first.runtime, id) !== undefined, "the session to be listed");
    await first.runtime.close();

    // Meanwhile another client renames it.
    const other = await t.client();
    await other.request("sessions.rename", { commandId: randomUUID(), sessionId: id, title: "Receipts" });

    const again = harness.runtime(inMemoryPlatform({ clock, documents: platform.documents, secrets: platform.secrets }));
    const seen: [string | undefined, string | undefined][] = [];
    const note = () => {
      const view = again.projections.sessionList.read();
      // Until the saved connections are read, no environment is known and the list is empty.
      if (view.environments.length === 0) return;
      const entry: [string | undefined, string | undefined] = [view.environments[0]?.freshness, view.rows[0]?.summary.title];
      const last = seen.at(-1);
      if (!last || last[0] !== entry[0] || last[1] !== entry[1]) seen.push(entry);
    };
    again.projections.sessionList.subscribe(note);
    await again.start();
    await until(() => seen.at(-1)?.[0] === "live", "the list to go live");

    expect(seen[0]).toEqual(["cached", "Invoices"]);
    expect(seen.map(([freshness]) => freshness).filter((f, i, all) => f !== all[i - 1])).toEqual(["cached", "catching-up", "live"]);
    expect(seen.at(-1)).toEqual(["live", "Receipts"]);
  });
});

describe("a session handle", () => {
  it("subscribes the session and keeps the subscription five minutes after release", async () => {
    const t = await harness.environment();
    const clock = manualClock();
    const { runtime, seams } = harness.withSeams(inMemoryPlatform({ clock }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const id = randomUUID();
    await send(seams, t.env.id, "sessions.create", { id, workspace, title: "Invoices" });
    const base = t.env.subscriptions();

    const handle = runtime.subscriptions.session(t.env.id, id);
    await until(() => handle.state.read().freshness === "live", "the session to go live");
    expect(handle.state.read()).toMatchObject({ summary: { id, title: "Invoices" }, deleted: false });
    expect(t.env.subscriptions()).toBe(base + 1);

    await send(seams, t.env.id, "sessions.rename", { sessionId: id, title: "Receipts" });
    await until(() => handle.state.read().summary?.title === "Receipts", "the rename to reach the handle");

    handle.release();
    clock.advance(SESSION_LINGER_MS - 1);
    expect(t.env.subscriptions()).toBe(base + 1);
    clock.advance(1);
    await until(() => t.env.subscriptions() === base, "the session's subscription to end");
  });
});

describe("merged groups across two environments", () => {
  it("head same-named groups together and split when one environment renames its group", async () => {
    const desk = await harness.environment({ name: "desk" });
    const laptop = await harness.environment({ name: "laptop" });
    const { runtime, seams } = harness.withSeams(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await desk.createPairing()).link });
    await runtime.connections.add({ link: (await laptop.createPairing()).link });
    const [deskGroup, laptopGroup] = [randomUUID(), randomUUID()];
    await send(seams, desk.env.id, "groups.create", { id: deskGroup, name: "Brandsolidate" });
    await send(seams, laptop.env.id, "groups.create", { id: laptopGroup, name: "  brandSOLIDATE " });

    await until(() => runtime.projections.sessionList.read().groups[0]?.groups.length === 2, "one heading over both groups");
    expect(runtime.projections.sessionList.read().groups.map((h) => h.name)).toEqual(["Brandsolidate"]);

    await send(seams, laptop.env.id, "groups.rename", { groupId: laptopGroup, name: "Brand" });
    await until(() => runtime.projections.sessionList.read().groups.length === 2, "the heading to split");
    expect(runtime.projections.sessionList.read().groups.map((h) => [h.name, h.groups.map((g) => g.environmentId)])).toEqual([
      ["Brandsolidate", [desk.env.id]],
      ["Brand", [laptop.env.id]],
    ]);
  });
});
