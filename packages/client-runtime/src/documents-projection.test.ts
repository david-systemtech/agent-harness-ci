import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { end, type Script } from "../../environment/test/fake-adapter.js";
import { workspace } from "../../environment/test/sessions.js";
import { holds, useHarness } from "../test/harness.js";
import type { SessionDocument } from "./projections/documents.js";
import { fakeShell, inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * `projections.documents` end to end (docs/specs/gui.md, "Client runtime,
 * contracts and environment additions"; #410): a run the fake adapter plays
 * writes a page and edits it, and a real runtime following the session
 * lists it as the run writes it; a runtime that opens the session once the
 * run is over lists it the same.
 */

const harness = useHarness();

describe("projections.documents", () => {
  it("lists what a run wrote as the run writes it, and the same for a client that opens the session afterwards", async () => {
    const page = join(workspace.path, "site", "index.html");
    const script: Script = async function* () {
      yield { type: "tool.started", payload: { toolCallId: "toolu_write", name: "Write", input: { file_path: page, content: "<h1>Receipts</h1>" }, title: null, agentId: null, parentToolCallId: null } };
      yield { type: "tool.ended", payload: { toolCallId: "toolu_write", status: "ok", output: "Written", durationMs: 3 } };
      yield { type: "tool.started", payload: { toolCallId: "toolu_edit", name: "Edit", input: { file_path: page, old_string: "Receipts", new_string: "Totals" }, title: null, agentId: null, parentToolCallId: null } };
      yield { type: "tool.ended", payload: { toolCallId: "toolu_edit", status: "ok", output: "Edited", durationMs: 3 } };
      yield end();
    };
    const t = await harness.environment({ name: "desk" });
    t.adapter.nextScripts.push(script);
    const runtime = harness.runtime(inMemoryPlatform({ shell: fakeShell() }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const env = t.env.id;
    const sessionId = randomUUID();
    expect(await runtime.commands.dispatch(env, "sessions.create", { id: sessionId, workspace, title: "Receipts" })).toMatchObject({ ok: true });

    const documents = runtime.projections.documents(env, sessionId);
    expect(runtime.projections.documents(env, sessionId.toUpperCase())).toBe(documents);
    onTestFinished(documents.subscribe(() => undefined));
    await holds(runtime.projections.session(env, sessionId), (session) => session.freshness === "live");
    expect(await runtime.commands.dispatch(env, "runs.start", { sessionId, text: "Make the receipts page" })).toMatchObject({ ok: true });

    const [written] = await holds(documents, (list) => list[0]?.revisions === 2);
    const { runs } = runtime.projections.session(env, sessionId).read();
    const expected: SessionDocument = {
      path: "site/index.html",
      kind: "page",
      first: { toolCallId: "toolu_write", runId: runs[0]!.runId, sequence: expect.any(Number), at: runs[0]!.startedAt },
      last: { toolCallId: "toolu_edit", runId: runs[0]!.runId, sequence: expect.any(Number), at: runs[0]!.startedAt },
      revisions: 2,
      size: 17,
    };
    expect(written).toEqual(expected);

    // Another client opens the session once the run is over: the same document, its times its run's.
    await holds(runtime.projections.session(env, sessionId), (session) => session.runs[0]?.state === "ended");
    const later = harness.runtime(inMemoryPlatform({ shell: fakeShell() }));
    await later.start();
    await later.connections.add({ link: (await t.createPairing()).link });
    const reopened = later.projections.documents(env, sessionId);
    onTestFinished(reopened.subscribe(() => undefined));
    await holds(later.projections.session(env, sessionId), (session) => session.freshness === "live");
    expect(reopened.read()).toEqual([written]);
  });
});
