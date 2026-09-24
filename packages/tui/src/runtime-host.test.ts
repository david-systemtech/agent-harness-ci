import { describe, expect, it } from "vitest";
import type { Runtime } from "@agent-harness/client-runtime";
import { createRuntimeHost } from "./runtime-host.js";

/**
 * The runtime host (`runtime-host.ts`): one runtime at a time, a restart
 * replacing it; once closed, nothing it holds is started again.
 */

/** A runtime that records its start and close, whose close resolves when the test says. */
const recorder = () => {
  const made: { started: number; closed: number; finishClose: () => void }[] = [];
  const make = (): Runtime => {
    let finish!: () => void;
    const closing = new Promise<void>((resolve) => (finish = resolve));
    const entry = { started: 0, closed: 0, finishClose: () => finish() };
    made.push(entry);
    return {
      start: async () => void entry.started++,
      close: async () => {
        entry.closed++;
        await closing;
      },
    } as unknown as Runtime;
  };
  return { made, make };
};

describe("the runtime host", () => {
  it("starts nothing and closes the fresh runtime when closed while a restart waits on the old one", async () => {
    const { made, make } = recorder();
    const host = createRuntimeHost(make);
    await host.start();
    const restarting = host.restart();
    const closing = host.close();
    for (const entry of made) entry.finishClose();
    await Promise.all([restarting, closing]);
    expect(made).toHaveLength(2);
    expect(made[1]).toMatchObject({ started: 0 });
    expect(made[1]?.closed).toBeGreaterThan(0);
    expect(host.started.read()).toBe(false);
  });

  it("refuses to start once closed", async () => {
    const { made, make } = recorder();
    const host = createRuntimeHost(make);
    made[0]?.finishClose();
    await host.close();
    await host.start();
    expect(made[0]).toMatchObject({ started: 0 });
    expect(host.started.read()).toBe(false);
  });
});
