import { describe, expect, it } from "vitest";
import { processLauncherChannel, type IpcProcess } from "./launcher.js";

/** A process with an IPC channel whose send succeeds, or fails with `error`. */
const ipcProcess = (events: unknown[], error: Error | null = null): IpcProcess => ({
  connected: true,
  send: (message, callback) => {
    events.push(message);
    callback(error);
    return error === null;
  },
  disconnect: () => void events.push("disconnect"),
});

describe("the launcher channel preset", () => {
  it("sends prepared over the IPC channel the launcher spawned the environment with, then lets the channel go", async () => {
    const events: unknown[] = [];
    await processLauncherChannel(ipcProcess(events)).prepared();
    expect(events).toEqual([{ type: "prepared" }, "disconnect"]);
  });

  it("fails the signal when the channel cannot deliver it", async () => {
    const events: unknown[] = [];
    await expect(processLauncherChannel(ipcProcess(events, new Error("channel closed"))).prepared()).rejects.toThrow(
      "channel closed",
    );
    expect(events).toEqual([{ type: "prepared" }]);
  });

  it("does nothing when the environment runs in the foreground, with no launcher", async () => {
    const disconnect = () => {
      throw new Error("nothing to disconnect");
    };
    await expect(processLauncherChannel({ connected: false, disconnect }).prepared()).resolves.toBeUndefined();
    await expect(
      processLauncherChannel({ connected: false, send: undefined, disconnect }).prepared(),
    ).resolves.toBeUndefined();
  });
});
