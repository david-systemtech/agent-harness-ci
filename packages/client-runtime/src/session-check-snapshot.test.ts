import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REPLAY_BOUND } from "../../environment/src/event-log/event-log.js";
import { workspace } from "../../environment/test/sessions.js";
import { holds, useHarness } from "../test/harness.js";
import { fakeShell, inMemoryPlatform } from "./testing/in-memory-platform.js";
import { transcriptRows } from "./transcript/rows.js";

const harness = useHarness();

describe("Workspace check snapshot catch-up", () => {
  it("keeps both Clients' finished and running rows when session replay exceeds its bound", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform({ shell: fakeShell() }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const sessionId = randomUUID();
    expect(await runtime.commands.dispatch(t.env.id, "sessions.create", { id: sessionId, workspace })).toMatchObject({ ok: true });
    const check = { terminalId: randomUUID(), command: "pnpm lint", sourceRunId: null };
    const running = { terminalId: randomUUID(), command: "pnpm typecheck", sourceRunId: randomUUID() };
    const result = { output: "Lint passed\n", truncated: false, exitCode: 0, signal: null, timedOut: false, failure: null };
    // Seed the producer's recorded events; no shell runs. Only the public runtime subscription observes them.
    const appended = t.env.log.atomically((tx) => t.env.log.append({ kind: "session", id: sessionId }, [
      { type: "checks.started", payload: check },
      { type: "checks.finished", payload: { ...check, ...result } },
      { type: "checks.started", payload: running },
      ...Array.from({ length: REPLAY_BOUND.events }, () => ({ type: "session.instructions-set", payload: { text: "" } })),
    ], { tx, actor: "system:checks" }));
    const session = runtime.projections.session(t.env.id, sessionId);
    const caughtUp = await holds(session, (view) => view.freshness === "live");
    expect(caughtUp.items).toEqual([
      { kind: "check", sequence: appended.events[0]!.sequence, ...check, state: "finished", result },
      { kind: "check", sequence: appended.events[2]!.sequence, ...running, state: "running", result: null },
    ]);
    expect(transcriptRows(caughtUp).map((row) => row.kind)).toEqual(["check", "check"]);
    t.env.log.atomically((tx) => t.env.log.append({ kind: "session", id: sessionId }, [
      { type: "checks.finished", payload: { ...running, ...result, exitCode: 1, output: "Typecheck failed\n" } },
    ], { tx, actor: "system:checks" }));
    const finished = await holds(session, (view) => view.items.every((item) => item.kind === "check" && item.state === "finished"));
    expect(finished.items[1]).toMatchObject({ sequence: appended.events[2]!.sequence, result: { exitCode: 1, output: "Typecheck failed\n" } });
  });
});
