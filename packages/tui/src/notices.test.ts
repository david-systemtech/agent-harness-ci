import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * What the runtime reports about a connection, rendered as it reports it
 * (docs/specs/tui.md, "First launch" and "When the environment is
 * unreachable"): a protocol mismatch says to update this client, or to update
 * the environment through its self-update when its flag is present; `revoked`
 * and `expired` show the runtime's notice with its action.
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

/** The activity line: the frame's last row. */
const activity = (app: RenderedApp) => app.frame().split("\n").at(-1) ?? "";
const noticeMessage = (app: RenderedApp) => app.runtime().projections.notices.read().at(-1)?.message ?? "(none)";

describe("the runtime's notices", () => {
  it("shows a revoked client session's notice, and the connection blocked", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    await app.waitFor("● laptop ready");
    app.environment("laptop").bye("revoked");
    await app.waitFor("was revoked");
    expect(app.frame()).toContain(noticeMessage(app).slice(0, 60));
    await app.waitFor("● laptop blocked: revoked");
    await app.type("/environment");
    await app.press(KEY.enter);
    await app.waitFor(/laptop\s+paired\s+blocked: revoked/);
  });

  it("shows an expired client session's notice with its action, pairing again", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    await app.waitFor("● laptop ready");
    app.environment("laptop").bye("expired");
    await app.waitFor("expired");
    expect(app.runtime().projections.notices.read().at(-1)).toMatchObject({ kind: "expired", action: "re-pair" });
    await app.waitFor("(/pair <link>, or /pair <address> <code>)");
    expect(app.frame()).toContain(noticeMessage(app).slice(0, 40));
  });

  it("says to update this client when the environment is newer", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    await app.waitFor("● laptop ready");
    const laptop = app.environment("laptop");
    laptop.discovery({ protocolVersion: PROTOCOL_VERSION + 1 });
    laptop.bye("protocol", { protocolVersion: PROTOCOL_VERSION + 1 });
    await app.waitFor("update this client");
    expect(app.runtime().projections.notices.read().at(-1)).toMatchObject({ kind: "unsupported-client", action: "update-client" });
    expect(activity(app)).toContain("laptop is newer than this client");
    await app.waitFor("● laptop blocked: unsupported-client");
  });

  it("says to update the environment through its self-update when it offers one", async () => {
    const newer = PROTOCOL_VERSION + 1;
    const app = await launch({
      script: { environments: [{ name: "laptop", reach: "paired", protocolVersion: newer, capabilities: ["self-update"] }] },
      protocolVersion: newer,
    });
    await app.waitFor("● laptop ready");
    const laptop = app.environment("laptop");
    laptop.discovery({ protocolVersion: PROTOCOL_VERSION, capabilities: ["self-update"] });
    laptop.bye("protocol", { protocolVersion: PROTOCOL_VERSION });
    await app.waitFor("update laptop to this client's version");
    expect(app.runtime().projections.notices.read().at(-1)).toMatchObject({ kind: "protocol-mismatch", action: "update-environment" });
    await app.waitFor("Its self-update is the way to do it.");
  });

  it("says the environment cannot update itself from here without the flag", async () => {
    const newer = PROTOCOL_VERSION + 1;
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired", protocolVersion: newer }] }, protocolVersion: newer });
    await app.waitFor("● laptop ready");
    const laptop = app.environment("laptop");
    laptop.discovery({ protocolVersion: PROTOCOL_VERSION });
    laptop.bye("protocol", { protocolVersion: PROTOCOL_VERSION });
    await app.waitFor("cannot update itself from here");
    expect(app.runtime().projections.notices.read().at(-1)).toMatchObject({ kind: "protocol-mismatch", action: null });
  });
});
