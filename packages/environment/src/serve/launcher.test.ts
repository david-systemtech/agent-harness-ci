import { describe, expect, it } from "vitest";
import { processLauncherChannel } from "./launcher.js";

describe("the launcher channel preset", () => {
  it("sends prepared over the IPC channel the launcher spawned the environment with", async () => {
    const sent: unknown[] = [];
    const channel = processLauncherChannel({
      connected: true,
      send: (message, callback) => {
        sent.push(message);
        callback(null);
        return true;
      },
    });
    await channel.prepared();
    expect(sent).toEqual([{ type: "prepared" }]);
  });

  it("fails the signal when the channel cannot deliver it", async () => {
    const channel = processLauncherChannel({
      connected: true,
      send: (_message, callback) => {
        callback(new Error("channel closed"));
        return false;
      },
    });
    await expect(channel.prepared()).rejects.toThrow("channel closed");
  });

  it("does nothing when the environment runs in the foreground, with no launcher", async () => {
    await expect(processLauncherChannel({ connected: false }).prepared()).resolves.toBeUndefined();
    await expect(processLauncherChannel({ connected: false, send: undefined }).prepared()).resolves.toBeUndefined();
  });
});
