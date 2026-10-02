import { randomUUID } from "node:crypto";
import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakePty, type FakePty } from "../../test/fake-pty.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { noticesOf } from "../../test/notices.js";
import { sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Workspace checks (switch-over spec, "Phase-D commands and parity",
 * Checks; #1187) over the typed wire: the directory's command shared by
 * every session and client in it and kept across a restart, and manual
 * checks run in the environment's own terminals, with a fake one-off
 * process port standing in for the shell, so no project command runs.
 */

const { onCleanup, tempDir } = useCleanups();

/** An environment whose one-off commands run through `run`, a fake: what the check's shell is asked to run is recorded, and the test makes it print and exit. */
const start = async (options: TestEnvironmentOptions & { readonly run?: FakePty } = {}): Promise<TestEnvironment & { readonly run: FakePty }> => {
  const run = options.run ?? fakePty();
  const t = await startTestEnvironment({ ...options, terminals: { ...options.terminals, run } });
  onCleanup(() => t.close());
  return { ...t, run };
};

/** A second client session of the environment, as another Client would hold. */
const otherClient = async (t: TestEnvironment): Promise<WireClient> => t.client({ token: (await t.bootstrap("desktop", "the other client")).token });

describe("a Workspace directory's check command", () => {
  it("is one per canonical directory, shared by its sessions and clients, announced by checks.changed naming the caller, and kept across a restart", async () => {
    const t = await start({ dataDir: tempDir("agent-harness-checks-data-") });
    const first = await t.client();
    const second = await otherClient(t);
    const dir = tempDir("agent-harness-checks-");
    const link = join(tempDir("agent-harness-checks-links-"), "project");
    symlinkSync(dir, link);
    const workspace = realpathSync(dir);
    const here = await sessionIn(first, dir);
    const throughLink = await sessionIn(second, link);
    expect(await second.request("checks.get", { sessionId: throughLink })).toEqual({ workspace, command: null });

    const head = t.env.log.head();
    const command = "  pnpm typecheck && pnpm exec vitest run 'a b.test.ts' \\\n  --maxWorkers=2\n";
    expect(await first.apply("checks.set", { commandId: randomUUID(), sessionId: here, command })).toEqual({ workspace, command });
    expect(await second.request("checks.get", { sessionId: throughLink })).toEqual({ workspace, command });
    const notices = await noticesOf(second, "checks.changed", head);
    expect(notices.map(({ payload, actor }) => ({ payload, actor }))).toEqual([{ payload: { workspace, command }, actor: { kind: "client_session", id: first.hello.clientSessionId } }]);

    const back = await restartAfter(t, 0, (options) => start(options));
    expect(await (await back.client()).request("checks.get", { sessionId: here })).toEqual({ workspace, command });
  });
});
