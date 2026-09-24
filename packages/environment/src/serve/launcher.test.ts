import { describe, expect, it } from "vitest";
import { processLauncherChannel, type IpcProcess } from "./launcher.js";

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
