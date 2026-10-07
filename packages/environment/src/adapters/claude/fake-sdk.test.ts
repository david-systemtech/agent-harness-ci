import { describe, expect, it } from "vitest";
import { FakeSdk } from "../../../test/fake-claude-sdk.js";

const makeQuery = (fake: FakeSdk) => fake.query({ prompt: "hello", options: {} });
const ticks = async (count: number) => {
  for (let tick = 0; tick < count; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe("the fake Claude SDK's made(count) (#1761)", () => {
  it("answers at once with the query already made", async () => {
    const fake = new FakeSdk();
    const first = makeQuery(fake);
    makeQuery(fake);
    await expect(fake.made(1)).resolves.toBe(first);
  });

  it("waits on the count-th query itself, however many timer ticks a loaded runner takes to make it", async () => {
    const fake = new FakeSdk();
    makeQuery(fake);
    const settled: string[] = [];
    const second = fake.made(2).then(
      (query) => { settled.push("made"); return query; },
      (error: unknown) => { settled.push(String(error)); throw error; },
    );
    await ticks(300);
    expect(settled).toEqual([]);
    const made = makeQuery(fake);
    await expect(second).resolves.toBe(made);
  });

  it("answers every waiter, each with its own query, as the queries come", async () => {
    const fake = new FakeSdk();
    const third = fake.made(3);
    const first = fake.made(1);
    const queries = [makeQuery(fake), makeQuery(fake), makeQuery(fake)];
    await expect(Promise.all([first, third])).resolves.toEqual([queries[0], queries[2]]);
  });
});
