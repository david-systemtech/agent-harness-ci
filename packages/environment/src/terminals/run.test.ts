import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakePty } from "../../test/fake-pty.js";
import { startTestEnvironment } from "../../test/helper.js";
import { follow, sessionIn } from "../../test/terminals.js";

const { onCleanup, tempDir } = useCleanups();

describe("terminals.run", () => {
  it("runs without a login shell or a controlling terminal, closes stdin, and streams its output and exit", async () => {
    const pty = fakePty();
    pty.unavailable = true;
    const t = await startTestEnvironment({ terminals: { pty, shell: () => ({ file: "/a/login/shell/that/must/not/start", args: [] }) } });
    onCleanup(() => t.close());
    const client = await t.client();
    const dir = tempDir("agent-harness-run-");
    const sessionId = await sessionIn(client, dir);
    const id = randomUUID();
    const head = t.env.log.head();
    const answer = await client.request("terminals.run", {
      commandId: randomUUID(), id, sessionId,
      command: `pwd; printf '%s\\n' "$RUN_TEST"; read line; printf 'input:%s\\n' "$?"; if (echo unexpected >/dev/tty) 2>/dev/null; then exit 99; fi; exit 7`,
      env: { RUN_TEST: "from the client" },
    });
    expect(answer).toMatchObject({ receipt: { status: "accepted", changed: false }, result: { terminal: { id, owner: "session", sessionId } } });
    const view = await follow(client, id);
    await view.until((v) => v.ended !== undefined);
    expect(view.text).toBe(`${realpathSync(dir)}\r\nfrom the client\r\ninput:1\r\n`);
    expect(view.exited).toEqual({ exitCode: 7, signal: null, cause: "exited" });
    expect(t.env.log.head()).toBe(head);
  });
  it("runs in the supplied cwd once on retries and rejects a reused terminal id", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const workspace = tempDir("agent-harness-workspace-");
    const cwd = tempDir("agent-harness-cwd-");
    const sessionId = await sessionIn(client, workspace);
    const id = randomUUID();
    const params = { commandId: randomUUID(), id, sessionId, command: "pwd", cwd };
    const first = await client.request("terminals.run", params);
    const view = await follow(client, id);
    await view.until((v) => v.ended !== undefined);
    expect(view.text).toBe(`${realpathSync(cwd)}\r\n`);
    expect(await client.request("terminals.run", params)).toEqual({ receipt: (first as { receipt: unknown }).receipt });
    expect(await client.request("terminals.run", { ...params, commandId: randomUUID() })).toMatchObject({ receipt: { status: "rejected", error: { data: { reason: "exists" } } } });
  });

  it("reports a failed spawn on the stream instead of leaving the command running", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const workspace = tempDir("agent-harness-workspace-");
    const sessionId = await sessionIn(client, workspace);
    const id = randomUUID();
    await client.request("terminals.run", { commandId: randomUUID(), id, sessionId, command: "pwd", cwd: workspace + "/missing" });
    const view = await follow(client, id);
    await view.until((v) => v.ended !== undefined);
    expect(view.exited).toEqual({ exitCode: -1, signal: null, cause: "failed" });
    expect(view.text).toContain("could not start");
  });

  it("reports a signal as a command exit rather than a failed spawn", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const sessionId = await sessionIn(client, tempDir("agent-harness-signal-"));
    const id = randomUUID();
    await client.request("terminals.run", { commandId: randomUUID(), id, sessionId, command: "kill -TERM $$" });
    const view = await follow(client, id);
    await view.until((v) => v.ended !== undefined);
    expect(view.exited).toEqual({ exitCode: 0, signal: 15, cause: "exited" });
  });

});
