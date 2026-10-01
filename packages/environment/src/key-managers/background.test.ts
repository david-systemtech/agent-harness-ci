import { describe, expect, it } from "vitest";
import { gate } from "../../test/fake-adapter.js";
import { createBackgroundWork } from "./background.js";

/**
 * The key managers' background work (#745): what `settled` waits on. A
 * piece's end is a gate the test opens, so whether it has settled is read
 * after the event loop has had every other turn it could take.
 */

/** Whether `promise` has settled once every turn queued before has run. */
const hasSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void promise.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
};

describe("the key managers' background work", () => {
  it("is settled at once when nothing was taken up", async () => {
    expect(await hasSettled(createBackgroundWork().settled())).toBe(true);
  });

  it("is settled once every piece taken up has ended", async () => {
    const work = createBackgroundWork();
    const [one, other] = [gate(), gate()];
    work.run(one.opened);
    work.run(other.opened);
    const settled = work.settled();

    one.open();
    expect(await hasSettled(settled)).toBe(false);
    other.open();
    expect(await hasSettled(settled)).toBe(true);
  });

  it("waits on a piece another took up before it ended, as a renewal that finds its login due takes up the verification", async () => {
    const work = createBackgroundWork();
    const [renewal, verification] = [gate(), gate()];
    work.run(renewal.opened.then(() => work.run(verification.opened)));
    const settled = work.settled();

    renewal.open();
    expect(await hasSettled(settled)).toBe(false);
    verification.open();
    expect(await hasSettled(settled)).toBe(true);
  });
});
