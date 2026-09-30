import { randomUUID } from "node:crypto";
import type { SessionBrowser, SessionBrowserSetPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { command, create, get, listStream, patchOf, refusal } from "../../test/sessions.js";

/**
 * The browser as a session field (browser spec, "The browser as a session
 * field"; ADR 0014, ADR 0003; #550) through the primary seam: an in-process
 * environment with the scripted fake adapter, the typed client over the
 * wire. What is asserted is what a client sees: the summary, the list's
 * patch, the session's stream.
 */

const { onCleanup } = useCleanups();

const start = async (adapter: FakeAdapterOptions = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const OTHER_ENVIRONMENT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const WORK_CHROME: SessionBrowser = { kind: "chrome", environmentId: OTHER_ENVIRONMENT, chromeId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" };
const MY_CHROME: SessionBrowser = { kind: "chrome", environmentId: OTHER_ENVIRONMENT, chromeId: null };

const eventsOf = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === type)
    .map((event) => event.payload as P);

describe("sessions.setBrowser", () => {
  it("sets the field and records session.browser.set chosen by a person; a second client's list shows it through the patch", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const other = await t.client();
    const list = await listStream(other, t.env.log.head());

    const answer = await command(client, "sessions.setBrowser", { sessionId: id, browser: WORK_CHROME });
    expect(answer.result?.summary.browser).toEqual(WORK_CHROME);
    expect(payloadsOf<SessionBrowserSetPayload>(t, id, "session.browser.set")).toEqual([{ browser: WORK_CHROME, chosenBy: "person" }]);

    const event = await list.next();
    expect(event.type).toBe("session.browser.set");
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { browser: WORK_CHROME } });
    expect(await get(other, id)).toMatchObject({ browser: WORK_CHROME });
  });

  it("takes every shape, and null for none chosen; the browser the session has appends nothing, and updatedAt stays", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    const createdAt = result?.summary.updatedAt;
    t.clock.advance(60_000);
    for (const browser of [MY_CHROME, { kind: "headless" }, { kind: "dock" }, { kind: "none" }, null] as const) {
      const answer = await command(client, "sessions.setBrowser", { sessionId: id, browser });
      expect(answer.result?.summary).toMatchObject({ browser, updatedAt: createdAt });
    }
    const again = await command(client, "sessions.setBrowser", { sessionId: id, browser: null });
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(payloadsOf<SessionBrowserSetPayload>(t, id, "session.browser.set").map((payload) => payload.browser)).toEqual([
      MY_CHROME,
      { kind: "headless" },
      { kind: "dock" },
      { kind: "none" },
      null,
    ]);
  });

  it("is refused for a client session without runs:drive, and for a session not here", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { token } = await t.pair({ scopes: ["read", "sessions:write"] });
    const organiser = await t.client({ token });
    expect(await refusal(organiser.request("sessions.setBrowser", { commandId: randomUUID(), sessionId: id, browser: { kind: "headless" } }))).toMatchObject({
      code: "forbidden",
      data: { scope: "runs:drive" },
    });
    expect(await get(client, id)).toMatchObject({ browser: null });

    const missing = randomUUID();
    const answer = await command(client, "sessions.setBrowser", { sessionId: missing, browser: { kind: "headless" } });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId: missing } } });
  });
});

describe("sessions.create's browser", () => {
  it("records the first session.browser.set after session.created, with who chose it: the reach default or a person", async () => {
    const t = await start();
    const client = await t.client();
    const byReach = await create(client, { browser: { value: MY_CHROME, chosenBy: "reach" } });
    expect(byReach.result?.summary.browser).toEqual(MY_CHROME);
    expect(eventsOf(t, byReach.id).map((event) => event.type)).toEqual(["session.created", "session.browser.set"]);
    expect(payloadsOf<SessionBrowserSetPayload>(t, byReach.id, "session.browser.set")).toEqual([{ browser: MY_CHROME, chosenBy: "reach" }]);

    const byPerson = await create(client, { browser: { value: { kind: "dock" }, chosenBy: "person" } });
    expect(await get(client, byPerson.id)).toMatchObject({ browser: { kind: "dock" } });
    expect(payloadsOf<SessionBrowserSetPayload>(t, byPerson.id, "session.browser.set")).toEqual([{ browser: { kind: "dock" }, chosenBy: "person" }]);
  });

  it("chooses none when absent: the field is null and nothing is recorded", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    expect(result?.summary.browser).toBeNull();
    expect(eventsOf(t, id).map((event) => event.type)).toEqual(["session.created"]);
  });
});
