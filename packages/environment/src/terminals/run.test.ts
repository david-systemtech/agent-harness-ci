import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  it("ends after the command exits even while a background child holds its output pipes", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const workspace = tempDir("agent-harness-background-");
    const sessionId = await sessionIn(client, workspace);
    const release = workspace + "/release";
    onCleanup(() => writeFileSync(release, "released"));
    const id = randomUUID();
    await client.request("terminals.run", {
      commandId: randomUUID(), id, sessionId,
      command: '(while [ -d "$WORKSPACE" ] && [ ! -e "$RELEASE" ]; do sleep 0.05; done) & i=0; while [ "$i" -lt 64 ]; do printf "%s" "$BLOCK"; i=$((i+1)); done; printf done; exit 7',
      env: { WORKSPACE: workspace, RELEASE: release, BLOCK: "x".repeat(4096), PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const view = await follow(client, id);
    await view.until((v) => v.ended !== undefined);
    expect(view.text).toBe("x".repeat(256 * 1024) + "done");
    expect(view.exited).toEqual({ exitCode: 7, signal: null, cause: "exited" });
  });

  it("finds commands on the cached login PATH without starting the login shell", async () => {
    const workspace = tempDir("agent-harness-login-path-");
    const bin = workspace + "/bin";
    mkdirSync(bin);
    const command = bin + "/profile-command";
    writeFileSync(command, "#!/bin/sh\nprintf 'from profile path'\n");
    chmodSync(command, 0o755);
    const t = await startTestEnvironment({
      managedTools: { readPath: async () => bin },
      terminals: { shell: () => ({ file: "/a/login/shell/that/must/not/start", args: [] }) },
    });
    onCleanup(() => t.close());
    const client = await t.client();
    const sessionId = await sessionIn(client, workspace);
    const id = randomUUID();
    await client.request("terminals.run", { commandId: randomUUID(), id, sessionId, command: "profile-command" });
    const view = await follow(client, id);
    await view.until((v) => v.ended !== undefined);
    expect(view.text).toBe("from profile path");
    expect(view.exited).toEqual({ exitCode: 0, signal: null, cause: "exited" });

    const overrideId = randomUUID();
    await client.request("terminals.run", {
      commandId: randomUUID(), id: overrideId, sessionId,
      command: 'printf "%s" "$PATH"', env: { PATH: "/explicit/client/path" },
    });
    const override = await follow(client, overrideId);
    await override.until((v) => v.ended !== undefined);
    expect(override.text).toBe("/explicit/client/path");
  });

  it("names the missing workspace even when the command overrides cwd", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const workspace = tempDir("agent-harness-missing-workspace-");
    const cwd = tempDir("agent-harness-command-cwd-");
    const sessionId = await sessionIn(client, workspace);
    rmSync(workspace, { recursive: true });
    const answer = await client.request("terminals.run", { commandId: randomUUID(), id: randomUUID(), sessionId, command: "pwd", cwd });
    expect(answer).toMatchObject({
      receipt: { status: "rejected", error: {
        message: `The session's workspace ${workspace} is gone, or did not answer in time.`,
        data: { reason: "workspace_missing", path: workspace },
      } },
    });
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
