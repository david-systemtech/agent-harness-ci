import { StateImportFinishedPayload } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { scriptedEnvironments } from "../../test/environments.js";
import { noticeEvent } from "../../test/events.js";
import { subscription } from "../../test/scripted.js";
import { streamDocument } from "../streams/cache.js";
import { createRuntime } from "../runtime.js";
import { flush } from "../testing/fake-wire.js";

const finished = (failed: StateImportFinishedPayload["failed"] = [{ label: "Skill collection Team", message: "Connect a forge for forge.test.", step: "forges", details: ["Repository: https://forge.test/team/skills"] }]) => StateImportFinishedPayload.parse({
  carried: { accounts: 0, archived: 0, pins: 0, groups: 0, forgeAccounts: 0, keyManagerConnections: 0, banks: 0, routines: 0, instructions: 0, skillSources: 0, alwaysOnSkills: 0, drafts: 0, devSites: 0 },
  reEnter: [], later: [], notCarried: [], failed,
});
const status = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false };

describe("projections.stateImportFailures", () => {
  it("reads failures from a snapshot and replaces them when another window's import finishes", async () => {
    const { runtime, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }, { name: "other" }] });
    const desk = environments[0]!;
    const view = runtime.projections.stateImportFailures(desk.wire.environmentId);
    const completion = runtime.projections.stateImportFinished(desk.wire.environmentId);
    expect(view.read()).toEqual([]);
    expect(completion.read()).toBeNull();
    desk.notices.snapshot(1, { status, stateImportFailures: finished().failed });
    await flush();
    expect(view.read()).toEqual(finished().failed);
    expect(completion.read()).toBeNull();
    expect(runtime.projections.stateImportFailures(environments[1]!.wire.environmentId).read()).toEqual([]);
    desk.notices.event(noticeEvent(2, desk.wire.environmentId, "state-import.finished", finished([])));
    await flush();
    expect(view.read()).toEqual([]);
    expect(completion.read()).toEqual(finished([]));
    expect(runtime.projections.stateImportFinished(environments[1]!.wire.environmentId).read()).toBeNull();
    const heard = completion.read();
    desk.notices.snapshot(3, { status, stateImportFailures: [] });
    await flush();
    expect(completion.read()).toBe(heard);
    desk.notices.event(noticeEvent(4, desk.wire.environmentId, "state-import.finished", finished()));
    await flush();
    expect(completion.read()).toEqual(finished());
  });

  it("keeps replayed failures for a restarted client resuming from its cached cursor", async () => {
    const { runtime, platform, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }] });
    const desk = environments[0]!;
    desk.notices.event(noticeEvent(1, desk.wire.environmentId, "state-import.finished", finished()));
    await flush();
    expect(runtime.projections.stateImportFailures(desk.wire.environmentId).read()).toEqual(finished().failed);
    await runtime.close();
    const restarted = createRuntime(platform);
    onTestFinished(() => restarted.close());
    const opening = restarted.start();
    await desk.wire.server.accept();
    const list = await subscription(desk.wire, "sessions.subscribe");
    list.synchronized(1);
    const notices = await subscription(desk.wire, "environment.subscribe");
    expect(notices.params["afterSequence"]).toBe(1);
    notices.synchronized(1);
    await opening;
    expect(restarted.projections.stateImportFailures(desk.wire.environmentId).read()).toEqual(finished().failed);
  });

  it("replays a cache from before failures were retained instead of resuming past the lost report", async () => {
    const { runtime, platform, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }] });
    const desk = environments[0]!;
    await runtime.close();
    await platform.documents.set(streamDocument(desk.wire.environmentId, "environment"), { format: 1, sequence: 1, snapshot: { status, look: {}, setup: [] } });
    const restarted = createRuntime(platform);
    onTestFinished(() => restarted.close());
    const opening = restarted.start();
    await desk.wire.server.accept();
    const list = await subscription(desk.wire, "sessions.subscribe");
    list.synchronized(1);
    const notices = await subscription(desk.wire, "environment.subscribe");
    expect(notices.params["afterSequence"]).toBe(0);
    notices.event(noticeEvent(1, desk.wire.environmentId, "state-import.finished", finished()));
    notices.synchronized(1);
    await opening;
    expect(restarted.projections.stateImportFailures(desk.wire.environmentId).read()).toEqual(finished().failed);
  });
});
