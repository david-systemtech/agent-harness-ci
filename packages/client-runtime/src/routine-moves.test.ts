import { randomUUID } from "node:crypto";
import { Frame, RoutineDefinitionInput } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { written } from "../../environment/test/routines.js";
import { holds, useHarness } from "../test/harness.js";
import { globalWebSocket, inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();
it("previews a move without changing either environment, then links the copy and disables its original", async () => {
  const desk = await harness.environment({ name: "desk" });
  const laptop = await harness.environment({ name: "laptop" });
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  for (const env of [desk, laptop]) await runtime.connections.add({ link: (await env.createPairing()).link });
  const id = randomUUID();
  expect(await runtime.commands.dispatch(desk.env.id, "routines.create", { routineId: id, definition: RoutineDefinitionInput.parse(written({ name: "Monday", schedule: { kind: "manual" } })) })).toMatchObject({ ok: true });
  const view = runtime.projections.routines;
  const stop = view.subscribe(() => undefined);
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id)));
  const move = await runtime.commands.moveRoutine(desk.env.id, id, laptop.env.id);
  expect(move).toMatchObject({ ok: true, documents: [{ definition: { name: "Monday", enabled: true }, issues: [] }] });
  expect((await runtime.requests.call(laptop.env.id, "routines.list", {}))).toMatchObject({ ok: true, result: { routines: [] } });
  if (!move.ok) throw new Error(move.error.message);
  const moved = await move.confirm();
  expect(moved).toMatchObject({ ok: true });
  if (!moved.ok) throw new Error(moved.error.message);
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id && r.definition.enabled === false)));
  expect(view.read().groups.flatMap(g => g.routines).map(r => r.listed)).toEqual(expect.arrayContaining([
    expect.objectContaining({ definition: expect.objectContaining({ enabled: false }), state: expect.objectContaining({ id, movedTo: expect.objectContaining({ environmentId: laptop.env.id, routineId: moved.routineId }) }) }),
    expect.objectContaining({ definition: expect.objectContaining({ enabled: true }), state: expect.objectContaining({ id: moved.routineId, movedFrom: expect.objectContaining({ environmentId: desk.env.id, routineId: id }) }) }),
  ]));
  stop();
});

it("moves from the cached list while the source is stopped and delivers its queued disable on restart", async () => {
  const { join } = await import("node:path");
  const { originOf } = await import("../test/harness.js");
  const { reachable } = await import("./outbox/overlay.js");
  const dataDir = join(harness.tempDir("agent-harness-move-"), "data");
  const desk = await harness.environment({ name: "desk", dataDir });
  const laptop = await harness.environment({ name: "laptop" });
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  for (const env of [desk, laptop]) await runtime.connections.add({ link: (await env.createPairing()).link });
  const id = randomUUID();
  await runtime.commands.dispatch(desk.env.id, "routines.create", { routineId: id, definition: RoutineDefinitionInput.parse(written({ name: "Monday", schedule: { kind: "manual" }, enabled: false })) });
  const view = runtime.projections.routines;
  const stop = view.subscribe(() => undefined);
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id)));
  await desk.close();
  await holds(runtime.connections.list, records => !reachable(records.find(r => r.environmentId === desk.env.id)));
  const move = await runtime.commands.moveRoutine(desk.env.id, id, laptop.env.id);
  expect(move).toMatchObject({ ok: true, documents: [{ definition: { enabled: false } }] });
  if (!move.ok) throw new Error(move.error.message);
  const moved = await move.confirm();
  expect(moved).toMatchObject({ ok: true });
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id && r.pending)));
  const back = await harness.environment({ name: "desk", dataDir, clock: desk.clock });
  await runtime.connections.setAddress(desk.env.id, originOf(back.address));
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id && r.listed?.state.movedTo !== null && !r.pending)));
  expect(await runtime.requests.call(desk.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [{ definition: { enabled: false }, state: { movedTo: { environmentId: laptop.env.id } } }] } });
  stop();
});

it("moves back into the original id, updates its definition and keeps both environments' history", async () => {
  const { end } = await import("../../environment/test/fake-adapter.js");
  const desk = await harness.environment({ name: "desk" });
  const laptop = await harness.environment({ name: "laptop" });
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  for (const env of [desk, laptop]) await runtime.connections.add({ link: (await env.createPairing()).link });
  const id = randomUUID();
  await runtime.commands.dispatch(desk.env.id, "routines.create", { routineId: id, definition: RoutineDefinitionInput.parse(written({ name: "Monday", schedule: { kind: "manual" } })) });
  const beforeFiring = await runtime.requests.call(desk.env.id, "routines.list", {});
  if (!beforeFiring.ok) throw new Error(beforeFiring.error.message);
  const definitionSequence = beforeFiring.result.routines[0]?.state.definitionSequence;
  desk.adapter.nextScripts.push(() => [end("completed", { resultText: "Original result" })]);
  await runtime.commands.dispatch(desk.env.id, "routines.runNow", { routineId: id });
  const history = runtime.projections.routineHistory(desk.env.id, id);
  const stopHistory = history.subscribe(() => undefined);
  await holds(history, h => h.entries[0]?.kind === "firing" && h.entries[0].endedAt !== null);
  const originalHistory = history.read().entries;
  expect(await runtime.requests.call(desk.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [{ state: { definitionSequence } }] } });
  const first = await runtime.commands.moveRoutine(desk.env.id, id, laptop.env.id);
  if (!first.ok) throw new Error(first.error.message);
  const copied = await first.confirm();
  if (!copied.ok) throw new Error(copied.error.message);
  const view = runtime.projections.routines;
  const stop = view.subscribe(() => undefined);
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id && r.listed?.state.movedTo?.routineId === copied.routineId)));
  await runtime.commands.dispatch(laptop.env.id, "routines.update", { routineId: copied.routineId, fields: { instructions: "The updated work" } });
  const back = await runtime.commands.moveRoutine(laptop.env.id, copied.routineId, desk.env.id);
  expect(back).toMatchObject({ ok: true, documents: [{ issues: [] }] });
  if (!back.ok) throw new Error(back.error.message);
  expect(await back.confirm()).toEqual({ ok: true, routineId: id });
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id && r.definition.enabled && r.listed?.state.movedTo === null)));
  expect(await runtime.requests.call(desk.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [{ definition: { enabled: true, instructions: "The updated work" }, state: { id, movedTo: null } }] } });
  expect(await runtime.requests.call(desk.env.id, "routines.history", { routineId: id })).toMatchObject({ ok: true, result: { entries: originalHistory } });
  expect(await runtime.requests.call(laptop.env.id, "routines.history", { routineId: copied.routineId })).toMatchObject({ ok: true, result: { entries: [] } });
  stopHistory();
  stop();
});

it("an independent runtime keeps the restored original enabled while the copy's disable is held at the same timestamp", async () => {
  const desk = await harness.environment({ name: "desk" });
  const laptop = await harness.environment({ name: "laptop", clock: desk.clock });
  const writer = harness.runtime(inMemoryPlatform());
  await writer.start();
  for (const env of [desk, laptop]) await writer.connections.add({ link: (await env.createPairing()).link });
  const id = randomUUID();
  await writer.commands.dispatch(desk.env.id, "routines.create", { routineId: id, definition: RoutineDefinitionInput.parse(written({ name: "Monday", schedule: { kind: "manual" } })) });
  const first = await writer.commands.moveRoutine(desk.env.id, id, laptop.env.id);
  if (!first.ok) throw new Error(first.error.message);
  const copied = await first.confirm();
  if (!copied.ok) throw new Error(copied.error.message);
  const firstView = writer.projections.routines;
  const stopFirst = firstView.subscribe(() => undefined);
  await holds(firstView, v => v.groups.some(g => g.routines.some(r => r.routineId === id && r.listed?.state.movedTo?.routineId === copied.routineId)));
  stopFirst();
  await writer.close();

  // Hold the copy's disable before it reaches the real environment, leaving both lists enabled.
  const base = globalWebSocket();
  let releaseDisable: (() => void) | undefined;
  let sawDisable: (() => void) | undefined;
  const disableHeld = new Promise<void>(resolve => { sawDisable = resolve; });
  const mover = harness.runtime(inMemoryPlatform({ webSocket: (url, handlers) => {
    const socket = base(url, handlers);
    return {
      ...socket,
      send(text) {
        const frame = Frame.parse(JSON.parse(text));
        if (frame.type === "request" && frame.method === "routines.disable" && frame.params["routineId"] === copied.routineId) {
          releaseDisable = () => socket.send(text);
          sawDisable?.();
        } else socket.send(text);
      },
    };
  } }));
  await mover.start();
  for (const env of [desk, laptop]) await mover.connections.add({ link: (await env.createPairing()).link });
  const back = await mover.commands.moveRoutine(laptop.env.id, copied.routineId, desk.env.id);
  if (!back.ok) throw new Error(back.error.message);
  expect(await back.confirm()).toEqual({ ok: true, routineId: id });
  await disableHeld;
  const observer = harness.runtime(inMemoryPlatform());
  await observer.start();
  for (const env of [desk, laptop]) await observer.connections.add({ link: (await env.createPairing()).link });
  const view = observer.projections.routines;
  const stop = view.subscribe(() => undefined);
  await holds(view, v => v.groups.length === 2 && v.groups.every(g => !g.stale && g.routines.length === 1 && g.routines.every(r => r.listed !== null)));
  // Two wire round trips let a settlement recheck and its resulting command reach either environment.
  for (let round = 0; round < 2; round++) await Promise.all([desk, laptop].map(env => observer.requests.call(env.env.id, "routines.list", {})));
  expect(await observer.requests.call(desk.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [{ definition: { enabled: true }, state: { id, movedTo: null } }] } });
  expect(await observer.requests.call(laptop.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [{ definition: { enabled: true }, state: { id: copied.routineId, movedTo: null } }] } });
  releaseDisable?.();
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === copied.routineId && !r.pending && !r.definition.enabled)));
  expect(await observer.requests.call(desk.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [{ definition: { enabled: true }, state: { id, movedTo: null } }] } });
  stop();
});

it("a second runtime following both environments settles a lost disable once, leaving an original edited since the move enabled", async () => {
  const { routineEvents } = await import("../../environment/test/routines.js");
  const desk = await harness.environment({ name: "desk" });
  const laptop = await harness.environment({ name: "laptop" });
  laptop.clock.advance(10_000);
  const writer = harness.runtime(inMemoryPlatform());
  await writer.start();
  for (const env of [desk, laptop]) await writer.connections.add({ link: (await env.createPairing()).link });
  const [id, editedId, unverifiedId] = [randomUUID(), randomUUID(), randomUUID()];
  // This runtime imports the linked copy but disappears before dispatching the source's disable.
  for (const [routineId, name] of [[id, "Monday"], [editedId, "Edited"], [unverifiedId, "Without a source snapshot"]] as const) {
    await writer.commands.dispatch(desk.env.id, "routines.create", { routineId, definition: RoutineDefinitionInput.parse(written({ name, schedule: { kind: "manual" } })) });
    await writer.commands.dispatch(desk.env.id, "routines.update", { routineId, fields: { instructions: "Edited before moving" } });
    const exported = await writer.requests.call(desk.env.id, "routines.export", { routineIds: [routineId] });
    if (!exported.ok) throw new Error(exported.error.message);
    const source = await writer.requests.call(desk.env.id, "routines.list", {});
    if (!source.ok) throw new Error(source.error.message);
    const definitionSequence = source.result.routines.find(r => r.state.id === routineId)?.state.definitionSequence;
    await writer.commands.dispatch(laptop.env.id, "routines.import", { yaml: exported.result.yaml, routineIds: [randomUUID()], movedFrom: { environmentId: desk.env.id, routineId, ...(routineId !== unverifiedId && { definitionSequence }) } });
  }
  await writer.commands.dispatch(desk.env.id, "routines.update", { routineId: editedId, fields: { instructions: "Changed after the move" } });
  expect(routineEvents(desk).filter(e => e.type === "routine.disabled")).toHaveLength(0);
  await writer.close();
  const settler = harness.runtime(inMemoryPlatform());
  await settler.start();
  for (const env of [desk, laptop]) await settler.connections.add({ link: (await env.createPairing()).link });
  const view = settler.projections.routines;
  const stop = view.subscribe(() => undefined);
  await holds(view, v => v.groups.some(g => g.routines.some(r => r.routineId === id && !r.definition.enabled)));
  expect(await settler.requests.call(desk.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: expect.arrayContaining([
    expect.objectContaining({ definition: expect.objectContaining({ enabled: false }), state: expect.objectContaining({ id, movedTo: expect.objectContaining({ environmentId: laptop.env.id }) }) }),
    expect.objectContaining({ definition: expect.objectContaining({ enabled: true }), state: expect.objectContaining({ id: editedId, movedTo: null }) }),
    expect.objectContaining({ definition: expect.objectContaining({ enabled: true }), state: expect.objectContaining({ id: unverifiedId, movedTo: null }) }),
  ]) } });
  settler.requests.refresh(desk.env.id, "routines.list", {});
  await settler.requests.call(desk.env.id, "routines.list", {});
  expect(routineEvents(desk).filter(e => e.type === "routine.disabled")).toHaveLength(1);
  stop();
});

it("shows a taken name and the target's missing dependencies and re-resolved workspace, then accepts another name", async () => {
  const desk = await harness.environment({ name: "desk" });
  const laptop = await harness.environment({ name: "laptop" });
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  for (const env of [desk, laptop]) await runtime.connections.add({ link: (await env.createPairing()).link });
  const id = randomUUID();
  await runtime.commands.dispatch(desk.env.id, "routines.create", { routineId: id, definition: RoutineDefinitionInput.parse(written({ name: "Monday", schedule: { kind: "manual" }, workspace: { kind: "directory", path: "/not-present-on-either-environment", repositoryIdentity: "https://example.com/david/tools" }, skills: ["unknown-skill"], preCheck: { kind: "script", path: "missing.sh", timeoutSeconds: 60 }, delivery: [{ kind: "webhook", target: "missing-endpoint", on: "both" }] })) });
  await runtime.commands.dispatch(laptop.env.id, "routines.create", { routineId: randomUUID(), definition: RoutineDefinitionInput.parse(written({ name: "Monday", schedule: { kind: "manual" } })) });
  const taken = await runtime.commands.moveRoutine(desk.env.id, id, laptop.env.id);
  expect(taken).toMatchObject({ ok: true, documents: [{ issues: [expect.objectContaining({ path: ["name"], params: expect.objectContaining({ reason: "name_taken" }) })], warnings: { workspace: { kind: "scratch", repositoryIdentity: null }, attention: expect.arrayContaining(["script_missing", "endpoint_missing"]) } }] });
  if (!taken.ok) throw new Error(taken.error.message);
  expect(await taken.confirm()).toMatchObject({ ok: false });
  const renamed = await runtime.commands.moveRoutine(desk.env.id, id, laptop.env.id, "Monday, moved");
  expect(renamed).toMatchObject({ ok: true, documents: [{ definition: { name: "Monday, moved", workspace: { kind: "scratch" } }, issues: [] }] });
  if (!renamed.ok) throw new Error(renamed.error.message);
  const confirmations = await Promise.all([renamed.confirm(), renamed.confirm()]);
  expect(confirmations[0]).toEqual(confirmations[1]);
  expect(confirmations[0]).toMatchObject({ ok: true });
  expect(await runtime.requests.call(laptop.env.id, "routines.list", {})).toMatchObject({ ok: true, result: { routines: [expect.objectContaining({ definition: expect.objectContaining({ name: "Monday" }) }), expect.objectContaining({ definition: expect.objectContaining({ name: "Monday, moved" }) })] } });
});

it("makes a move absent with its reason when the source is down and no cached definition is held", async () => {
  const { reachable } = await import("./outbox/overlay.js");
  const desk = await harness.environment({ name: "desk" });
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  await runtime.connections.add({ link: (await desk.createPairing()).link });
  const id = randomUUID();
  expect(runtime.commands.routineMoveCapability(desk.env.id, id)).toEqual({ status: "present" });
  await desk.close();
  await holds(runtime.connections.list, rs => !reachable(rs.find(r => r.environmentId === desk.env.id)));
  expect(runtime.commands.routineMoveCapability(desk.env.id, id)).toMatchObject({ status: "absent", reason: "unreachable", message: expect.stringContaining("cached definition") });
});
