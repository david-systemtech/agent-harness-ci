import { describe, expect, it } from "vitest";
import { processLauncherChannel, type IpcProcess, type LauncherQuery, type LauncherReply } from "./launcher.js";

/** A process with an IPC channel whose send succeeds, or fails with `error`. */
const ipcProcess = (events: unknown[], error: Error | null = null): IpcProcess => {
  let connected = true;
  return {
    get connected() {
      return connected;
    },
    send: (message, callback) => {
      events.push(message);
      callback(error);
      return error === null;
    },
    disconnect: () => {
      connected = false;
      events.push("disconnect");
    },
  };
};

describe("the launcher channel preset", () => {
  it("sends prepared over the IPC channel the launcher spawned the environment with, and keeps the channel open", async () => {
    const events: unknown[] = [];
    await processLauncherChannel(ipcProcess(events)).prepared();
    expect(events).toEqual([{ type: "prepared" }]);
  });

  it("lets the channel go when closed, once", async () => {
    const events: unknown[] = [];
    const channel = processLauncherChannel(ipcProcess(events));
    await channel.prepared();
    await channel.close();
    await channel.close();
    expect(events).toEqual([{ type: "prepared" }, "disconnect"]);
  });

  it("fails the signal when the channel cannot deliver it", async () => {
    const events: unknown[] = [];
    await expect(processLauncherChannel(ipcProcess(events, new Error("channel closed"))).prepared()).rejects.toThrow(
      "channel closed",
    );
    expect(events).toEqual([{ type: "prepared" }]);
  });

  it("fails the signal when the launcher disconnected before the gate", async () => {
    const channel = processLauncherChannel({ send: () => true, connected: false, disconnect: () => undefined });
    await expect(channel.prepared()).rejects.toThrow(/disconnected/);
  });

  it("does nothing when the environment runs in the foreground, with no launcher", async () => {
    const disconnect = () => {
      throw new Error("nothing to disconnect");
    };
    const foreground = processLauncherChannel({ connected: false, send: undefined, disconnect });
    await expect(foreground.prepared()).resolves.toBeUndefined();
    await expect(foreground.close()).resolves.toBeUndefined();
  });
});

/** A process with an IPC channel the test can put launcher messages on, recording what the environment sends back. */
const queryingProcess = () => {
  const sent: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let connected = true;
  const proc: IpcProcess = {
    get connected() {
      return connected;
    },
    send: (message, callback) => {
      sent.push(message);
      callback(null);
      return true;
    },
    disconnect: () => void (connected = false),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const deliver = (message: unknown) => {
    for (const listener of [...listeners]) listener(message);
  };
  return { proc, sent, deliver, listening: () => listeners.size };
};

describe("the launcher channel's queries", () => {
  const answer = (query: LauncherQuery): LauncherReply =>
    query.type === "drain"
      ? { type: "draining", drainingSince: "2026-09-24T00:00:00.000Z" }
      : { type: "idle", idle: false, state: "busy", reason: "run-running" };

  it("answers the launcher's idle and drain queries over IPC, one reply each, and ignores anything else", async () => {
    const { proc, sent, deliver } = queryingProcess();
    const channel = processLauncherChannel(proc);
    await channel.prepared();
    channel.onQuery?.(answer);
    deliver({ type: "idle?" });
    deliver({ type: "drain" });
    for (const other of [{ type: "status" }, "drain", null, { kind: "drain" }]) deliver(other);
    expect(sent).toEqual([
      { type: "prepared" },
      { type: "idle", idle: false, state: "busy", reason: "run-running" },
      { type: "draining", drainingSince: "2026-09-24T00:00:00.000Z" },
    ]);
  });

  it("stops listening when closed, so the channel no longer holds the process open", async () => {
    const { proc, sent, deliver, listening } = queryingProcess();
    const channel = processLauncherChannel(proc);
    channel.onQuery?.(answer);
    expect(listening()).toBe(1);
    await channel.close();
    expect(listening()).toBe(0);
    deliver({ type: "idle?" });
    expect(sent).toEqual([]);
  });

  it("answers nothing, and does not throw, when the environment runs with no launcher", () => {
    const foreground = processLauncherChannel({ connected: false, send: undefined, disconnect: () => undefined });
    expect(() => foreground.onQuery?.(answer)).not.toThrow();
  });
});
