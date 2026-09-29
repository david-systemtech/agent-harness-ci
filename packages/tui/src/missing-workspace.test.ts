import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * A session whose workspace is missing (workspace-picker spec, "Missing
 * workspaces" and "Renderers"; ADR 0021; #328), through the #143 harness
 * against the scripted environment: its composer replaced by the gone path
 * and a Choose a workspace line, and `/cwd` there opening the workspace
 * step (its kinds the new-session card's, #334), which sends
 * `sessions.setWorkspace`.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const OTHER = "0199aa00-0000-4000-8000-000000000002";
const GONE = "/home/seth/receipts";

const launch = async (environment: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: {
      environments: [
        {
          name: "desk",
          reach: "local",
          sessions: [
            { id: SESSION, title: "Receipts", workspace: { kind: "directory", path: GONE }, workspaceMissingSince: "2026-09-23T12:00:00.000Z" },
            { id: OTHER, title: "Parser", workspace: { kind: "directory", path: "/home/seth/parser" }, lastActivityAt: "2026-09-23T13:00:00.000Z" },
          ],
          ...environment,
        },
      ],
    },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const send = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

const setWorkspaces = (app: RenderedApp) => app.environment("desk").requests("sessions.setWorkspace").map((request) => request.params);

describe("a session whose workspace is missing", () => {
  it("replaces the composer with the gone path and a Choose a workspace line, and sends no message", async () => {
    const { app, env } = await launch();
    await app.waitFor(`${GONE} is gone`);
    expect(app.frame()).toContain("Choose a workspace: /cwd");
    expect(app.frame()).not.toContain("message the agent");

    await send(app, "Fix the receipts");

    await app.waitFor(`Not sent: ${GONE} is gone; /cwd chooses a workspace for the session.`);
    expect(env.requests("runs.start")).toEqual([]);
  });

  it("opens the workspace step on /cwd, offering the directories the environment's sessions use, and sends sessions.setWorkspace with the one chosen; the composer comes back", async () => {
    const { app } = await launch();
    await app.waitFor(`${GONE} is gone`);

    await send(app, "/cwd");

    await app.waitFor("Choose a workspace for “Receipts” on desk");
    await app.waitFor("/home/seth/parser");
    await app.type("/home/seth/receipts-moved");
    await app.press(KEY.enter);
    await app.waitUntil(() => setWorkspaces(app).length === 1, "sessions.setWorkspace sent");
    expect(setWorkspaces(app)).toEqual([{ commandId: expect.any(String), sessionId: SESSION, workspace: { kind: "directory", path: "/home/seth/receipts-moved" } }]);
    await app.waitFor("message the agent");
    expect(app.frame()).not.toContain("is gone");
    expect(app.frame()).not.toContain("Choose a workspace for");
  });

  it("names the environment's refusal of the path chosen on the step, which stays open for another", async () => {
    const { app } = await launch({ directories: { "/srv/gone": "does_not_exist" } });
    await send(app, "/cwd");
    await app.waitFor("Choose a workspace for “Receipts” on desk");

    await app.type("/srv/gone");
    await app.press(KEY.enter);

    await app.waitFor("/srv/gone does not exist on desk.");
    expect(app.frame()).toContain("Choose a workspace for “Receipts” on desk");
    expect(app.frame()).toContain(`${GONE} is gone`);
  });

  it("offers the workspace step's other kinds too: scratch given as the session's workspace", async () => {
    const { app } = await launch();
    await send(app, "/cwd");
    await app.waitFor("Choose a workspace for “Receipts” on desk");
    await app.waitFor("Browse desk's directories");
    expect(app.frame()).toContain("A worktree");
    for (let i = 0; i < 10 && !app.frame().includes("› Scratch"); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitUntil(() => setWorkspaces(app).length === 1, "sessions.setWorkspace sent");
    expect(setWorkspaces(app)).toEqual([{ commandId: expect.any(String), sessionId: SESSION, workspace: { kind: "scratch" } }]);
    await app.waitFor("message the agent");
  });

  it("leaves /cwd starting a new session when the open session's workspace is there", async () => {
    const { app } = await launch({ sessions: [{ id: SESSION, title: "Receipts", workspace: { kind: "directory", path: GONE } }] });
    await app.waitFor("message the agent");

    await send(app, "/cwd");

    await app.waitFor("New session on desk: where it works");
  });
});
