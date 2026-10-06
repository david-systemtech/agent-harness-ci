import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { parseEnvironmentMessage, type LauncherQuery, type LauncherReply } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { NO_LAUNCHER, processLauncherChannel, type IpcProcess } from "./launcher.js";

const { onCleanup } = useCleanups();

/** How long a forked child may take to start and answer under a loaded runner: tsx compiles it first. */
const SPAWN_WAIT = { timeout: 20_000, interval: 10 };

/**
 * A process with an IPC channel, as a launcher spawns the environment: the
 * test puts launcher messages on it with `deliver`, goes away with `leave`,
 * and reads what the environment sent in `sent`. `failSend` makes every send
 * fail as a closed channel's does.
 */
const ipcProcess = (options: { readonly failSend?: Error; readonly connected?: boolean } = {}) => {
  const sent: unknown[] = [];
  const events: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const leaving = new Set<() => void>();
  let connected = options.connected ?? true;
  const proc: IpcProcess = {
    get connected() {
      return connected;
    },
    send: (message, callback) => {
      sent.push(message);
      events.push(message);
      callback(options.failSend ?? null);
      return options.failSend === undefined;
    },
    disconnect: () => {
      connected = false;
      events.push("disconnect");
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onDisconnect: (listener) => {
      leaving.add(listener);
      return () => void leaving.delete(listener);
    },
  };
  const deliver = (message: unknown) => {
    for (const listener of [...listeners]) listener(message);
  };
  const leave = () => {
    connected = false;
    for (const listener of [...leaving]) listener();
  };
  return { proc, sent, events, deliver, leave, listening: () => listeners.size };
};

/** A process `serve` runs in the foreground: no IPC channel, so no launcher. */
const foregroundProcess = (): IpcProcess => ({
  connected: false,
  send: undefined,
  disconnect: () => {
    throw new Error("nothing to disconnect");
  },
  onMessage: () => () => undefined,
  onDisconnect: () => () => undefined,
});

/** Whether `promise` has settled after the queued callbacks have run. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe("the launcher channel's startup handshake", () => {
  it("says prepared with the version the environment runs, and settles only once the launcher answers committed", async () => {
    const { proc, sent, deliver } = ipcProcess();
    const prepared = Promise.resolve(processLauncherChannel(proc).prepared("0.4.0"));
    expect(sent).toEqual([{ type: "prepared", version: "0.4.0" }]);
    expect(await settled(prepared)).toBe(false);
    for (const other of [{ type: "installed", id: 1 }, { type: "commit" }, "committed", null]) deliver(other);
    expect(await settled(prepared)).toBe(false);
    deliver({ type: "committed" });
    await expect(prepared).resolves.toBeUndefined();
  });

  it("fails the start when the launcher disconnects before committing", async () => {
    const { proc, deliver, leave } = ipcProcess();
    const prepared = processLauncherChannel(proc).prepared("0.4.0");
    leave();
    deliver({ type: "committed" });
    await expect(prepared).rejects.toThrow(/disconnected before .*committed/);
  });

  it("fails the start when the launcher disconnected before prepared could be said", async () => {
    const { proc, sent } = ipcProcess({ connected: false });
    await expect(processLauncherChannel(proc).prepared("0.4.0")).rejects.toThrow(/disconnected/);
    expect(sent).toEqual([]);
  });

  it("fails the start when the channel cannot deliver prepared", async () => {
    const { proc, sent } = ipcProcess({ failSend: new Error("channel closed") });
    await expect(processLauncherChannel(proc).prepared("0.4.0")).rejects.toThrow("channel closed");
    expect(sent).toEqual([{ type: "prepared", version: "0.4.0" }]);
  });

  it("does not wait when the environment runs in the foreground, with no launcher", async () => {
    const foreground = processLauncherChannel(foregroundProcess());
    await expect(foreground.prepared("0.4.0")).resolves.toBeUndefined();
    await expect(foreground.close()).resolves.toBeUndefined();
  });

  it("lets the channel go when closed, once", async () => {
    const { proc, events, deliver } = ipcProcess();
    const channel = processLauncherChannel(proc);
    const prepared = channel.prepared("0.4.0");
    deliver({ type: "committed" });
    await prepared;
    await channel.close();
    await channel.close();
    expect(events).toEqual([{ type: "prepared", version: "0.4.0" }, "disconnect"]);
  });

  it("says a launcher is present when one spawned the environment with an IPC channel, and not in the foreground", () => {
    expect(processLauncherChannel(ipcProcess().proc).present()).toBe(true);
    expect(processLauncherChannel(foregroundProcess()).present()).toBe(false);
  });
});

describe("the start's word on its OS keychain read (#1689)", () => {
  it("tells the launcher where a read waiting on the person stands, as a message the launcher reads", () => {
    const { proc, sent } = ipcProcess();
    const channel = processLauncherChannel(proc);
    channel.credentialAccess?.("waiting");
    channel.credentialAccess?.("answered");
    expect(sent).toEqual([
      { type: "credential-access", state: "waiting" },
      { type: "credential-access", state: "answered" },
    ]);
    expect(sent.map(parseEnvironmentMessage)).toEqual(sent);
  });

  it("says nothing once the launcher's channel is gone, or with no launcher", () => {
    const gone = ipcProcess({ connected: false });
    processLauncherChannel(gone.proc).credentialAccess?.("waiting");
    expect(gone.sent).toEqual([]);
    expect(() => processLauncherChannel(foregroundProcess()).credentialAccess?.("waiting")).not.toThrow();
  });
});

describe("the environment's requests to the launcher", () => {
  it("asks install?, switch? and versions?, each with an id, and settles each with the answer that repeats its id", async () => {
    const { proc, sent, deliver } = ipcProcess();
    const channel = processLauncherChannel(proc);
    const install = channel.request({ type: "install?", version: "0.5.0", staged: "/data/staging/0.5.0" });
    const switching = channel.request({ type: "switch?", updateId: "u-1", version: "0.5.0" });
    const versions = channel.request({ type: "versions?" });
    expect(sent).toEqual([
      { type: "install?", id: 1, version: "0.5.0", staged: "/data/staging/0.5.0" },
      { type: "switch?", id: 2, updateId: "u-1", version: "0.5.0" },
      { type: "versions?", id: 3 },
    ]);

    // Answered out of order: the id pairs each answer with its request.
    deliver({ type: "versions", id: 3, installed: ["0.4.0", "0.5.0"], launcherVersion: "0.4.0", launcherProtocol: 1 });
    deliver({ type: "switching", id: 2 });
    deliver({ type: "installed", id: 1 });
    expect(await install).toEqual({ type: "installed" });
    expect(await switching).toEqual({ type: "switching" });
    expect(await versions).toEqual({ type: "versions", installed: ["0.4.0", "0.5.0"], launcherVersion: "0.4.0", launcherProtocol: 1 });
  });

  it("settles install? refused with each reason the launcher gives, and switch? refused with its own", async () => {
    const { proc, deliver } = ipcProcess();
    const channel = processLauncherChannel(proc);
    let id = 0;
    for (const reason of ["launcher-protocol", "incomplete", "preflight", "disk", "io"] as const) {
      const answer = channel.request({ type: "install?", version: "0.5.0", staged: "/data/staging/0.5.0" });
      deliver({ type: "refused", id: ++id, reason });
      expect(await answer).toEqual({ type: "refused", reason });
    }
    for (const reason of ["not-installed", "disk", "io"] as const) {
      const answer = channel.request({ type: "switch?", updateId: "u-1", version: "0.5.0" });
      deliver({ type: "refused", id: ++id, reason });
      expect(await answer).toEqual({ type: "refused", reason });
    }
  });

  it("ignores what does not answer a request: an unknown message, an unknown id, an answer of another kind, a refusal the request cannot take", async () => {
    const { proc, deliver } = ipcProcess();
    const channel = processLauncherChannel(proc);
    const install = channel.request({ type: "install?", version: "0.5.0", staged: "/data/staging/0.5.0" });
    for (const other of [
      { type: "installed", id: 2 },
      { type: "switching", id: 1 },
      { type: "versions", id: 1, installed: [], launcherVersion: "0.4.0", launcherProtocol: 1 },
      { type: "refused", id: 1, reason: "not-installed" },
      { type: "refused", id: 1, reason: "tired" },
      { type: "installed" },
      { type: "committed" },
      { type: "hello", id: 1 },
      "installed",
      null,
    ]) {
      deliver(other);
    }
    expect(await settled(install)).toBe(false);
    deliver({ type: "installed", id: 1 });
    expect(await install).toEqual({ type: "installed" });
    // Answered once: a second answer to the same id is ignored like any other.
    deliver({ type: "refused", id: 1, reason: "io" });
    expect(await install).toEqual({ type: "installed" });
  });

  it("refuses every request at once when no launcher is present, sending nothing", async () => {
    const channel = processLauncherChannel(foregroundProcess());
    expect(await channel.request({ type: "install?", version: "0.5.0", staged: "/data/staging/0.5.0" })).toEqual(NO_LAUNCHER);
    expect(await channel.request({ type: "switch?", updateId: "u-1", version: "0.5.0" })).toEqual(NO_LAUNCHER);
    expect(await channel.request({ type: "versions?" })).toEqual(NO_LAUNCHER);
  });

  it("refuses the requests outstanding when the launcher goes, and those asked after it has gone, at once", async () => {
    const { proc, sent, leave } = ipcProcess();
    const channel = processLauncherChannel(proc);
    const install = channel.request({ type: "install?", version: "0.5.0", staged: "/data/staging/0.5.0" });
    const versions = channel.request({ type: "versions?" });
    leave();
    expect(await install).toEqual(NO_LAUNCHER);
    expect(await versions).toEqual(NO_LAUNCHER);
    expect(await channel.request({ type: "versions?" })).toEqual(NO_LAUNCHER);
    expect(sent).toHaveLength(2);
  });

  it("refuses a request the channel cannot deliver, and those outstanding when it is closed", async () => {
    const failing = processLauncherChannel(ipcProcess({ failSend: new Error("channel closed") }).proc);
    expect(await failing.request({ type: "versions?" })).toEqual(NO_LAUNCHER);

    const { proc, sent } = ipcProcess();
    const channel = processLauncherChannel(proc);
    const outstanding = channel.request({ type: "versions?" });
    await channel.close();
    expect(await outstanding).toEqual(NO_LAUNCHER);
    expect(await channel.request({ type: "versions?" })).toEqual(NO_LAUNCHER);
    expect(sent).toHaveLength(1);
  });
});

describe("the launcher's queries", () => {
  const idle: LauncherReply = {
    type: "idle",
    readiness: "ready",
    activity: { state: "busy", reason: "run-running" },
    updatesManagedOutside: false,
  };
  const draining: LauncherReply = { type: "draining", drainingSince: "2026-09-24T00:00:00.000Z", trigger: "launcher" };
  const answer = (query: LauncherQuery): LauncherReply => (query.type === "drain?" ? draining : idle);

  it("answers the launcher's idle and drain queries over IPC, one reply each, and ignores anything else", async () => {
    const { proc, sent, deliver } = ipcProcess();
    const channel = processLauncherChannel(proc);
    const prepared = channel.prepared("0.4.0");
    deliver({ type: "committed" });
    await prepared;
    channel.onQuery(answer);
    deliver({ type: "idle?" });
    deliver({ type: "drain?" });
    for (const other of [{ type: "status" }, { type: "drain" }, "drain?", null, { kind: "drain?" }]) deliver(other);
    expect(sent).toEqual([{ type: "prepared", version: "0.4.0" }, idle, draining]);
  });

  it("stops listening when closed, so the channel no longer holds the process open", async () => {
    const { proc, sent, deliver, listening } = ipcProcess();
    const channel = processLauncherChannel(proc);
    channel.onQuery(answer);
    expect(listening()).toBe(1);
    await channel.close();
    expect(listening()).toBe(0);
    deliver({ type: "idle?" });
    expect(sent).toEqual([]);
  });

  it("answers nothing, and does not throw, when the environment runs with no launcher", () => {
    const foreground = processLauncherChannel(foregroundProcess());
    expect(() => foreground.onQuery(answer)).not.toThrow();
  });
});

describe("the preset channel over a real IPC channel", () => {
  const child = new URL("../../test/launcher-child.ts", import.meta.url).pathname;
  const tsx = createRequire(import.meta.url).resolve("tsx");

  /** Forks the stand-in child as a launcher does, with an IPC channel: what it sends, its report lines, and its exit. */
  const forkChild = (version: string) => {
    const forked = fork(child, [version], {
      execArgv: ["--conditions=@agent-harness/source", "--import", tsx],
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    onCleanup(() => void forked.kill("SIGKILL"));
    const messages: unknown[] = [];
    const lines: unknown[] = [];
    let buffered = "";
    forked.on("message", (message) => messages.push(message));
    forked.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const complete = buffered.split("\n");
      buffered = complete.pop() ?? "";
      for (const line of complete) lines.push(JSON.parse(line));
    });
    const exited = new Promise<number | null>((resolve) => forked.on("exit", (code) => resolve(code)));
    const nth = (list: unknown[], n: number) => vi.waitFor(() => list[n] ?? Promise.reject(new Error(`nothing at ${n} yet`)), SPAWN_WAIT);
    return { forked, messages, lines, exited, message: (n: number) => nth(messages, n), line: (n: number) => nth(lines, n) };
  };

  it("says prepared, and once committed asks the launcher and answers its queries, through the process's own channel", async () => {
    const { forked, messages, lines, exited, message, line } = forkChild("0.4.0");
    expect(parseEnvironmentMessage(await message(0))).toEqual({ type: "prepared", version: "0.4.0" });
    expect(lines).toEqual([]);

    forked.send({ type: "committed" });
    expect(await line(0)).toEqual({ committed: true });
    expect(parseEnvironmentMessage(await message(1))).toEqual({ type: "versions?", id: 1 });
    forked.send({ type: "versions", id: 1, installed: ["0.4.0"], launcherVersion: "0.3.0", launcherProtocol: 1 });
    expect(await line(1)).toEqual({ versions: { type: "versions", installed: ["0.4.0"], launcherVersion: "0.3.0", launcherProtocol: 1 } });

    forked.send({ type: "idle?" });
    expect(parseEnvironmentMessage(await message(2))).toEqual({ type: "idle", readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false });
    forked.disconnect();
    expect(await exited).toBe(0);
    expect(messages).toHaveLength(3);
  });

  it("fails the start when the launcher disconnects before committing", async () => {
    const { forked, exited, message, line } = forkChild("0.4.0");
    await message(0);
    forked.disconnect();
    expect(await line(0)).toEqual({ failed: expect.stringMatching(/disconnected before the launcher committed/) as string });
    expect(await exited).toBe(1);
  });
});
