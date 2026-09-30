import { randomUUID } from "node:crypto";
import { EnvironmentNotice, registry, type ClientKind, type EventFrame, type KnownEnvironment } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, refusal, workspace } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * The known environments (key-managers spec, "The orientation block"; ADR
 * 0011; #382) through the primary seam: an in-process environment, clients
 * of each kind over real WebSockets reporting their other connections, and
 * the fake adapter reporting the instructions a run was spawned with. What
 * is asserted is the other environments section a run and a preview are
 * handed, the refusal a program gets, and the notices a watcher hears.
 */

const { onCleanup } = useCleanups();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }] });
  onCleanup(() => t.close());
  return t;
};

/** A paired client session of `kind` and a client on it. */
const clientOf = async (t: TestEnvironment, kind: ClientKind) => {
  const credential = await t.pair({ kind, scopes: ["read"] });
  return { credential, client: await t.client({ token: credential.token, clientKind: kind }) };
};

const laptop = { id: "0192a5b0-7c1e-7d4a-9f00-000000000001", name: "laptop", address: "http://laptop.tail1234.ts.net:7433" } as const;
const nas = { id: "0192a5b0-7c1e-7d4a-9f00-000000000002", name: "Attic NAS", address: "https://[fd7a:115c::7]:7433" } as const;
const desk = { id: "0192a5b0-7c1e-7d4a-9f00-000000000003", name: "desk", address: "http://desk:7433" } as const;

const report = (client: WireClient, environments: readonly KnownEnvironment[]) => client.request("environment.knownEnvironments.report", { environments: [...environments] });

const HEADING = "Other environments the user's clients connect to, where work can run too, each with the address a client uses to reach it:";

/** The block a new run of the account would be handed now, asked on a socket closed after, so no socket pings while the clock is moved on. */
const preview = async (t: TestEnvironment): Promise<string> => {
  const client = await t.client();
  try {
    return (await client.request("instructions.preview", { accountId: "claude-max", workspace })).text;
  } finally {
    await client.close();
  }
};

/** The other environments section's paragraphs, the block's last; null when the block has none. */
const otherEnvironmentsOf = (text: string): string[] | null => {
  const start = text.indexOf("## Other environments\n\n");
  return start === -1 ? null : text.slice(start + "## Other environments\n\n".length).split("\n\n");
};

/** The section as it lists these lines. */
const listing = (...lines: string[]) => [[HEADING, ...lines.map((line) => `- ${line}`)].join("\n")];

/** A client subscribed to the environment's notices from now: the known-environments notices it hears next, in order. */
const watch = async (t: TestEnvironment) => {
  const watcher = await t.client();
  const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  await watcher.next((f) => f.type === "synchronized" && f.subscription === subscription);
  return async (): Promise<unknown> => {
    for (;;) {
      const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
      const notice = EnvironmentNotice.parse(frame.event);
      if (notice.type === "environment.known-environments-updated") return notice.payload;
    }
  };
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session, waits for its end, and answers the instructions it was handed. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text: string): Promise<string> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1), { timeout: WAIT_MS });
  return t.adapter.lastRun().input.instructions;
};

describe("the other environments section", () => {
  it("is left out until a client reports another environment", async () => {
    const t = await start();
    expect(otherEnvironmentsOf(await preview(t))).toBeNull();
    await report((await clientOf(t, "desktop")).client, []);
    expect(otherEnvironmentsOf(await preview(t))).toBeNull();
  });

  it("lists the union of what a desktop and a terminal UI report, last in the block, sorted by name, each with its name, white space collapsed, and the address the client uses, never this environment", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);
    const here = { id: t.env.id, name: "this one", address: "http://127.0.0.1:7433" };
    await report((await clientOf(t, "desktop")).client, [laptop, here, { ...nas, name: "  Attic \n NAS " }]);
    await report((await clientOf(t, "tui")).client, [{ ...laptop, address: "http://100.64.0.7:7433" }, desk, { ...here, address: "http://mnl:7433" }]);

    const instructions = await runTo(t, client, session.id, "Where else can this run?");

    expect(instructions.match(/^## .+$/gm)?.at(-1)).toBe("## Other environments");
    expect(otherEnvironmentsOf(instructions)).toEqual(
      listing("Attic NAS at https://[fd7a:115c::7]:7433.", "desk at http://desk:7433.", "laptop at http://100.64.0.7:7433.", "laptop at http://laptop.tail1234.ts.net:7433."),
    );
    expect(instructions).not.toContain("this one");
  });

  it("takes a client session's report whole, in place of its last", async () => {
    const t = await start();
    const { client } = await clientOf(t, "desktop");
    await report(client, [laptop, nas]);
    await report(client, [desk]);
    expect(otherEnvironmentsOf(await preview(t))).toEqual(listing("desk at http://desk:7433."));
  });

  it("is byte-identical while the union is unchanged, whichever client reported last, so the session's process is reused", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);
    const desktop = (await clientOf(t, "desktop")).client;
    const terminal = (await clientOf(t, "tui")).client;
    await report(desktop, [laptop, nas]);
    await report(terminal, [nas]);
    const first = await runTo(t, client, session.id, "First");

    await report(terminal, [laptop, nas]);
    await report(desktop, [nas]);
    const second = await runTo(t, client, session.id, "Second");

    expect(second).toBe(first);
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
    await report(terminal, [nas]);
    expect(await runTo(t, client, session.id, "Third")).not.toBe(first);
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
  });
});

describe("environment.knownEnvironments.report", () => {
  it("is refused forbidden, the reason program, for a program client session, and its report is not taken", async () => {
    const t = await start();
    const { client } = await clientOf(t, "program");
    expect(await refusal(report(client, [laptop]))).toEqual({ code: "forbidden", data: { scope: "read", reason: "program" } });
    expect(otherEnvironmentsOf(await preview(t))).toBeNull();
  });

  it("raises environment.known-environments-updated with the union when the union changes, and none for a report that changes nothing", async () => {
    const t = await start();
    const next = await watch(t);
    const desktop = (await clientOf(t, "desktop")).client;
    const terminal = (await clientOf(t, "tui")).client;
    await report(desktop, [laptop, nas]);
    // The same union: another client's report of it, a report in another order, one naming this environment.
    await report(terminal, [nas]);
    await report(desktop, [nas, laptop, { id: t.env.id, name: "this one", address: "http://mnl:7433" }]);
    await report(desktop, [laptop]);
    await report(terminal, []);

    // The second notice heard is the last report's: none came between.
    expect(await next()).toEqual({ environments: [{ name: nas.name, address: nas.address }, { name: laptop.name, address: laptop.address }] });
    expect(await next()).toEqual({ environments: [{ name: laptop.name, address: laptop.address }] });
  });
});

describe("a client session's report", () => {
  it("is dropped when the client session is revoked, and the change is noticed", async () => {
    const t = await start();
    const next = await watch(t);
    const { credential, client } = await clientOf(t, "desktop");
    await report(client, [laptop]);
    await report((await clientOf(t, "tui")).client, [nas]);
    expect(await next()).toEqual({ environments: [{ name: laptop.name, address: laptop.address }] });
    expect(await next()).toEqual({ environments: [{ name: nas.name, address: nas.address }, { name: laptop.name, address: laptop.address }] });

    await (await t.client()).request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: credential.clientSessionId });

    expect(await next()).toEqual({ environments: [{ name: nas.name, address: nas.address }] });
    expect(otherEnvironmentsOf(await preview(t))).toEqual(listing("Attic NAS at https://[fd7a:115c::7]:7433."));
  });

  // Thirty days on the manual clock run every minute's sweep in one go, which blocks the process for seconds under load: the
  // time allowed for that, as update-route.test.ts allows it.
  it("is dropped when the client session expires, and kept past its first expiry once it is refreshed", { timeout: 120_000 }, async () => {
    const t = await start();
    const expiring = await clientOf(t, "desktop");
    const refreshed = await clientOf(t, "tui");
    await report(expiring.client, [laptop]);
    await report(refreshed.client, [nas]);
    // No socket stays open while the clock moves days on, so none is pinged every fifteen seconds of them.
    await expiring.client.close();
    await refreshed.client.close();
    t.clock.advance(HOUR);
    const refreshing = await t.client({ token: refreshed.credential.token, clientKind: "tui" });
    await refreshing.request("access.sessions.refresh", { commandId: randomUUID() });
    await refreshing.close();

    t.clock.advance(30 * DAY - HOUR - 1);
    expect(otherEnvironmentsOf(await preview(t))).toEqual(listing("Attic NAS at https://[fd7a:115c::7]:7433.", "laptop at http://laptop.tail1234.ts.net:7433."));
    t.clock.advance(1);
    expect(otherEnvironmentsOf(await preview(t))).toEqual(listing("Attic NAS at https://[fd7a:115c::7]:7433."));
    t.clock.advance(HOUR);
    expect(otherEnvironmentsOf(await preview(t))).toBeNull();
  });
});
