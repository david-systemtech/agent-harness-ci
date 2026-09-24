import { describe, expect, it } from "vitest";
import { createCloserStack } from "./closers.js";

describe("the closer stack", () => {
  it("closes newest first", async () => {
    const closed: string[] = [];
    const stack = createCloserStack();
    stack.push(() => void closed.push("event log"));
    stack.push(() => void closed.push("listener"));
    await stack.closeAll();
    expect(closed).toEqual(["listener", "event log"]);
  });

  it("runs every closer when one throws, rethrows that error, and retries only it next time", async () => {
    const closed: string[] = [];
    let listenerFails = true;
    const stack = createCloserStack();
    stack.push(() => void closed.push("event log"));
    stack.push(async () => {
      if (listenerFails) throw new Error("the listener would not close");
      closed.push("listener");
    });
    await expect(stack.closeAll()).rejects.toThrow("the listener would not close");
    expect(closed).toEqual(["event log"]);

    listenerFails = false;
    await stack.closeAll();
    expect(closed).toEqual(["event log", "listener"]);
    await stack.closeAll();
    expect(closed).toEqual(["event log", "listener"]);
  });

  it("gathers several failures into one AggregateError, the first failure first", async () => {
    const stack = createCloserStack();
    stack.push(() => {
      throw new Error("older");
    });
    stack.push(() => {
      throw new Error("newer");
    });
    const failure = await stack.closeAll().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual(["newer", "older"]);
    expect((failure as AggregateError).message).toContain("newer");
  });
});
