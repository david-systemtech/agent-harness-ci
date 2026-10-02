import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * What the runtime reports about a connection, rendered as it reports it
 * (docs/specs/tui.md, "First launch" and "When the environment is
 * unreachable"): a protocol mismatch says to update this client, or to update
 * the environment through its self-update when its flag is present; `revoked`
 * and `expired` show the runtime's notice with its action. The activity line
 * shows the latest and counts the rest, and `/notices` stacks every one of
 * `projections.notices`, newest first (#149).
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

  it("says to update the environment from its card in /environment when it can update itself", async () => {
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
    await app.waitFor("Its card in /environment offers the update.");
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

  it("gives the activity line to a notice that comes after a fault, so a fault never hides what follows", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    await app.waitFor("● laptop ready");
    app.fault("Fault: the documents directory is full.");
    await app.waitFor("Fault: the documents directory is full.");
    expect(activity(app)).toContain("Fault: the documents directory is full.");
    await app.tick();
    app.environment("laptop").bye("revoked");
    await app.waitFor("was revoked");
    expect(activity(app)).toContain("was revoked");
    expect(app.frame()).not.toContain("Fault: the documents directory is full.");
  });

  it("counts the notices under the latest on the activity line, and stacks them all in /notices, newest first", async () => {
    const app = await launch({
      script: {
        environments: [
          { name: "laptop", reach: "paired" },
          { name: "tower", reach: "paired", sessions: [{ title: "Deploy" }] },
        ],
      },
    });
    await app.waitFor("● laptop ready");
    const tower = app.environment("tower");
    const { runId } = tower.startRun(tower.sessionId(), "Ship it");
    tower.openPrompt(tower.sessionId(), { runId, summary: "Bash: kubectl apply" });
    await app.waitFor("Deploy is waiting on tower: Bash: kubectl apply");
    await app.tick();
    app.environment("laptop").bye("revoked");
    await app.waitFor("was revoked");
    await app.tick();
    tower.bye("expired");
    await app.waitFor("expired");
    await app.waitFor("(+2 more: /notices)");

    await app.type("/notices");
    await app.press(KEY.enter);
    await app.waitFor("Notices");
    const rows = app.rows();
    const at = (text: string) => rows.findIndex((row) => row.includes(text));
    expect(at("waiting on tower")).toBeGreaterThan(-1);
    expect(at("expired")).toBeLessThan(at("was revoked"));
    expect(at("was revoked")).toBeLessThan(at("waiting on tower"));
    expect(app.frame()).toContain("(/pair <link>, or /pair <address> <code>)");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("Notices"), "the card closed");
  });

  it("says there are none in /notices when nothing has been noticed", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    await app.waitFor("● laptop ready");
    await app.type("/notices");
    await app.press(KEY.enter);
    await app.waitFor("No notices.");
  });
});
