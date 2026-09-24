import { describe, expect, it } from "vitest";
import { createConfigDirQueue } from "./config-dir-queue.js";

/**
 * The config-directory queue (claude-adapter spec, "Modules and ownership"):
 * the SDK's standalone helpers (`listSessions`, `getSessionMessages`,
 * `renameSession` and the rest) take no config directory; they read
 * `CLAUDE_CONFIG_DIR` from the process environment, at call time and again
 * after their own awaits. So each call runs with the variable set to its
 * account's directory, alone. A helper's reads are observed here through a
 * fake environment, across awaits, as the SDK's would be.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A helper that reads the variable, awaits, and reads it again, as the SDK's session helpers do. */
const helper = (env: Record<string, string | undefined>, log: string[], name: string) => async (): Promise<string | undefined> => {
  log.push(`${name} start ${env["CLAUDE_CONFIG_DIR"] ?? "-"}`);
  await tick();
  await tick();
  const seen = env["CLAUDE_CONFIG_DIR"];
  log.push(`${name} end ${seen ?? "-"}`);
  return seen;
};

/** Timers the test fires by hand, in the order they were set. */
const manualTimers = () => {
  const set: { callback: () => void; cancelled: boolean }[] = [];
  return {
    setTimeout: (callback: () => void) => {
      const timer = { callback, cancelled: false };
      set.push(timer);
      return { cancel: () => void (timer.cancelled = true) };
    },
    /** Fires the `index`th timer set, unless it was cancelled. */
    fire: (index: number) => {
      const timer = set[index];
      if (timer !== undefined && !timer.cancelled) timer.callback();
    },
  };
};

describe("the config-directory queue", () => {
  it("serialises two helpers on one directory", async () => {
    const env: Record<string, string | undefined> = {};
    const queue = createConfigDirQueue(env);
    const log: string[] = [];
    await Promise.all([queue.run("/accounts/a", helper(env, log, "one")), queue.run("/accounts/a", helper(env, log, "two"))]);
    expect(log).toEqual(["one start /accounts/a", "one end /accounts/a", "two start /accounts/a", "two end /accounts/a"]);
  });

  it("serialises helpers on two directories too, so neither reads the other's: the variable is process-wide", async () => {
    const env: Record<string, string | undefined> = {};
    const queue = createConfigDirQueue(env);
    const log: string[] = [];
    const [a, b] = await Promise.all([queue.run("/accounts/a", helper(env, log, "a")), queue.run("/accounts/b", helper(env, log, "b"))]);
    expect([a, b]).toEqual(["/accounts/a", "/accounts/b"]);
    expect(log).toEqual(["a start /accounts/a", "a end /accounts/a", "b start /accounts/b", "b end /accounts/b"]);
  });

  it("puts the variable back as it was after each call", async () => {
    const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: "/home/david/.claude" };
    const queue = createConfigDirQueue(env);
    await queue.run("/accounts/a", async () => undefined);
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/home/david/.claude");
    const bare: Record<string, string | undefined> = {};
    await createConfigDirQueue(bare).run("/accounts/a", async () => undefined);
    expect(bare).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("refuses a helper that does not answer in time, and runs the next once it settles, with the variable restored", async () => {
    const env: Record<string, string | undefined> = {};
    const timers = manualTimers();
    const queue = createConfigDirQueue(env, { timeoutMs: 1_000, setTimeout: timers.setTimeout });
    let free: () => void = () => undefined;
    const wedged = queue.run("/accounts/a", () => new Promise<void>((resolve) => (free = resolve)));
    const next = queue.run("/accounts/b", async () => env["CLAUDE_CONFIG_DIR"]);
    await tick();
    timers.fire(0);
    await expect(wedged).rejects.toThrow(/did not answer within 1000 ms/);
    free();
    await expect(next).resolves.toBe("/accounts/b");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("keeps a timed-out helper's directory until it settles, so a helper that resumes after its time reads its own and the next waits for it", async () => {
    const env: Record<string, string | undefined> = {};
    const timers = manualTimers();
    const queue = createConfigDirQueue(env, { timeoutMs: 1_000, setTimeout: timers.setTimeout });
    const log: string[] = [];
    let free: () => void = () => undefined;
    const freed = new Promise<void>((resolve) => (free = resolve));
    // Wedged on a store lock that later frees, then reading the variable again and writing under it, as a mutation helper does.
    const wedged = queue.run("/accounts/a", async () => {
      log.push(`a start ${env["CLAUDE_CONFIG_DIR"] ?? "-"}`);
      await freed;
      log.push(`a writes under ${env["CLAUDE_CONFIG_DIR"] ?? "-"}`);
    });
    const next = queue.run("/accounts/b", helper(env, log, "b"));
    await tick();
    timers.fire(0);
    await expect(wedged).rejects.toThrow(/did not answer within 1000 ms/);
    await tick();
    expect(log).toEqual(["a start /accounts/a"]);
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/accounts/a");

    free();
    await expect(next).resolves.toBe("/accounts/b");
    expect(log).toEqual(["a start /accounts/a", "a writes under /accounts/a", "b start /accounts/b", "b end /accounts/b"]);
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("refuses a call whose time runs out while it waits behind a helper that never settles, and never runs it", async () => {
    const env: Record<string, string | undefined> = {};
    const timers = manualTimers();
    const queue = createConfigDirQueue(env, { timeoutMs: 1_000, setTimeout: timers.setTimeout });
    const wedged = queue.run("/accounts/a", () => new Promise<never>(() => undefined));
    let ran = false;
    const waiting = queue.run("/accounts/b", async () => {
      ran = true;
    });
    await tick();
    timers.fire(0);
    timers.fire(1);
    await expect(wedged).rejects.toThrow(/did not answer within 1000 ms/);
    await expect(waiting).rejects.toThrow(/did not answer within 1000 ms/);
    await tick();
    expect(ran).toBe(false);
  });

  it("keeps going after a helper throws, with the variable restored", async () => {
    const env: Record<string, string | undefined> = {};
    const queue = createConfigDirQueue(env);
    const failed = queue.run("/accounts/a", async () => {
      throw new Error("unreadable store");
    });
    const next = queue.run("/accounts/b", async () => env["CLAUDE_CONFIG_DIR"]);
    await expect(failed).rejects.toThrow("unreadable store");
    await expect(next).resolves.toBe("/accounts/b");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("runs a helper that throws synchronously as a rejection, not a throw from run", async () => {
    const queue = createConfigDirQueue({});
    await expect(
      queue.run("/accounts/a", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
  });
});
