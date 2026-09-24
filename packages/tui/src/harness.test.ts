import { inMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeWithSeams } from "../../client-runtime/src/internal.js";
import { renderApp, type RenderedApp } from "../test/harness.js";

/**
 * The scripted fake environment every terminal UI ticket uses
 * (docs/specs/tui.md, "Testing Decisions"): sessions and groups on one or two
 * environments, receipts with chosen outcomes, `bye` reasons, and discovery
 * answering `starting` or nothing. Asserted through the runtime's public
 * surface, since the rail that renders sessions is a later ticket's.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});
const launch = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args);
  apps.push(app);
  return app;
};

const phaseOf = (app: RenderedApp, name: string) => app.runtime().projections.environments.read().find((v) => v.name === name)?.phase;

describe("the scripted environment", () => {
  it("scripts sessions and groups on two environments", async () => {
    const app = await launch({
      script: {
        environments: [
          { name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }, { title: "Pairing" }], groups: [{ name: "Brandsolidate" }] },
          { name: "laptop", reach: "paired", sessions: [{ title: "Train tidy-up" }], groups: [{ name: "brandsolidate" }] },
        ],
      },
    });
    const runtime = app.runtime();
    const [desk, laptop] = app.world.environments.map((e) => e.environmentId) as [string, string];
    const deskSessions = await runtime.requests.call(desk, "sessions.list", {});
    const laptopGroups = await runtime.requests.call(laptop, "groups.list", {});
    expect(deskSessions).toMatchObject({ ok: true, result: { sessions: [{ title: "Fix the rail" }, { title: "Pairing" }] } });
    expect(laptopGroups).toMatchObject({ ok: true, result: { groups: [{ name: "brandsolidate" }] } });
  });

  it("answers commands with the receipts the script chose", async () => {
    const app = await launch({
      script: {
        environments: [
          {
            name: "desk",
            reach: "local",
            sessions: [{ title: "Gone" }],
            receipts: { "sessions.archive": { rejected: "not_found", message: "No such session." }, "sessions.pin": "accepted" },
          },
        ],
      },
    });
    // A command goes through the outbox (#128), never `requests.call`; until it lands, a runtime's own request seam sends it.
    const { runtime, seams } = createRuntimeWithSeams(
      inMemoryPlatform({ clock: app.clock, kind: "tui", label: "seth@desk:pts/4", fetch: app.world.fetch, webSocket: app.world.webSocket, ...(app.world.grant && { grant: app.world.grant }) }),
    );
    const starting = runtime.start();
    await app.tick();
    await starting;
    await app.waitUntil(() => runtime.connections.list.read()[0]?.phase === "ready", "the second runtime ready");
    const desk = app.environment("desk").environmentId;
    const sessionId = "0199aa00-0000-4000-8000-000000000001";
    const archive = await seams.request(desk, "sessions.archive", { commandId: "0199aa00-0000-7000-8000-0000000000a1", sessionId });
    const pin = await seams.request(desk, "sessions.pin", { commandId: "0199aa00-0000-7000-8000-0000000000a2", sessionId });
    await runtime.close();
    expect(archive.result).toMatchObject({ receipt: { status: "rejected", reason: "not_found", error: { message: "No such session." } } });
    expect(pin.result).toMatchObject({ receipt: { status: "accepted" } });
  });

  it("says bye with any reason", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    app.environment("laptop").bye("draining");
    await app.waitUntil(() => phaseOf(app, "laptop") === "draining", "draining");
  });

  it("answers discovery with starting, or with nothing", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "starting" }, { name: "laptop", reach: "paired" }] } });
    expect(app.runtime().local.read()).toMatchObject({ state: "failed", reason: "starting" });
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await app.waitUntil(() => phaseOf(app, "laptop") === "backoff", "laptop backing off");
    laptop.discovery("starting");
    await app.advance(2000);
    await app.waitUntil(() => phaseOf(app, "laptop") === "starting", "laptop starting");
  });
});
