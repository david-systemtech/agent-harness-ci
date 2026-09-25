import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type EnvironmentHandle, type RenderedApp } from "../test/harness.js";

/**
 * The parked-asks card (docs/specs/tui.md, "Cards: permissions, questions,
 * parked asks"; #149): `/asks`, and `Ctrl+]` when more than one session is
 * parked, gather every environment's parked prompts from `projections.runs`
 * into one card, each row with its environment's badge and a countdown to
 * its TTL on its environment's clock; `y` and `n` answer a permission in
 * place, Enter opens the session, Esc closes deciding nothing. With one
 * session parked, `Ctrl+]` goes to it.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const RECEIPTS = "0199aa00-0000-4000-8000-000000000001";
const NOTES = "0199aa00-0000-4000-8000-000000000002";
const DEPLOY = "0199aa00-0000-4000-8000-0000000000d1";

/** How far the laptop's clock runs ahead of this terminal's, when a test says it does: a TTL is counted down on its clock. */
const LAPTOP_AHEAD_MS = 10 * 60_000;

/** Two environments: the desk here, with two sessions, and a laptop paired, with one, its clock ahead when `ahead`. */
const launch = async (options: { readonly ahead?: boolean } = {}) => {
  const app = await renderApp({
    script: {
      environments: [
        { name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Notes" }] },
        {
          name: "laptop",
          reach: "paired",
          sessions: [{ id: DEPLOY, title: "Deploy" }],
          ...(options.ahead === true && { hello: { serverTime: new Date(Date.parse(MANUAL_CLOCK_START) + LAPTOP_AHEAD_MS).toISOString() } }),
        },
      ],
    },
  });
  apps.push(app);
  await app.waitFor("● desk ready");
  const desk = app.environment("desk");
  const laptop = app.environment("laptop");
  return { app, desk, laptop };
};

/** Starts a run on the session and parks a prompt on it; answers its id. */
const parkOn = (env: EnvironmentHandle, sessionId: string, prompt: Parameters<EnvironmentHandle["openPrompt"]>[1] = {}) => {
  env.startRun(sessionId, "Go on");
  return env.openPrompt(sessionId, prompt);
};

const answersSent = (env: EnvironmentHandle) => env.requests("permissions.prompts.answer").map((r) => r.params);

const openAsks = async (app: RenderedApp) => {
  await app.type("/asks");
  await app.press(KEY.enter);
  await app.waitFor("waiting on you");
};

describe("the parked-asks card", () => {
  it("gathers every environment's parked prompts, each with its badge and a countdown on its environment's clock; one with no expiry shows none", async () => {
    const { app, desk, laptop } = await launch({ ahead: true });
    parkOn(desk, RECEIPTS, { summary: "Bash: rm -rf build" });
    // Two hours and half a minute from now on the laptop's clock.
    const expires = app.clock.now().getTime() + LAPTOP_AHEAD_MS + 2 * 60 * 60_000 + 30_000;
    parkOn(laptop, DEPLOY, { summary: "Bash: kubectl apply", ttlExpiresAt: new Date(expires).toISOString() });
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 2, "both prompts parked");
    await openAsks(app);
    expect(app.frame()).toContain("⚿ 2 prompts are waiting on you");
    const receipts = app.rows().find((row) => row.includes("Bash: rm -rf build")) ?? "";
    const deploy = app.rows().find((row) => row.includes("Bash: kubectl apply")) ?? "";
    expect(receipts).toContain("DE");
    expect(receipts).toContain("Receipts");
    expect(receipts).not.toContain(" left");
    expect(deploy).toContain("LA");
    expect(deploy).toContain("Deploy");
    // Two hours on the laptop's clock, not two hours and ten minutes on this terminal's.
    expect(deploy).toContain("2h 0m left");
    await app.jump(61_000);
    await app.waitFor("1h 59m left");
  });

  it("answers y and n in place, each row leaving at once; Esc closes deciding nothing", async () => {
    const { app, desk, laptop } = await launch();
    // Oldest first, on one clock: a frame apart.
    const first = parkOn(desk, RECEIPTS, { summary: "Bash: rm -rf build" });
    await app.tick();
    const second = parkOn(laptop, DEPLOY, { summary: "Bash: kubectl apply" });
    await app.tick();
    const third = parkOn(desk, NOTES, { summary: "Bash: git push" });
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 3, "three prompts parked");
    await openAsks(app);
    await app.press("y");
    await app.waitUntil(() => answersSent(desk).length === 1, "the first answered");
    expect(answersSent(desk)[0]).toEqual({ commandId: expect.any(String), promptId: first, sessionId: RECEIPTS, decision: "allow" });
    expect(app.frame()).not.toContain("Bash: rm -rf build");
    expect(app.frame()).toContain("❯");
    await app.press("n");
    await app.waitUntil(() => answersSent(laptop).length === 1, "the second answered");
    expect(answersSent(laptop)[0]).toEqual({ commandId: expect.any(String), promptId: second, sessionId: DEPLOY, decision: "deny" });
    await app.waitFor("⚿ 1 prompt is waiting on you");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("waiting on you"), "the card closed");
    expect(answersSent(desk)).toHaveLength(1);
    expect(app.runtime().projections.runs.read().parkedAsks.map((ask) => ask.promptId)).toEqual([third]);
  });

  it("opens the session a row came from on Enter, whose own card then answers it", async () => {
    const { app, laptop } = await launch();
    parkOn(laptop, DEPLOY, { summary: "Bash: kubectl apply" });
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 1, "the prompt parked");
    await openAsks(app);
    await app.press(KEY.enter);
    await app.waitFor("⚿ Permission");
    expect(app.frame()).toContain("Deploy");
    expect(app.frame()).not.toContain("waiting on you");
  });

  it("opens a question row rather than answering it in place, and asks before allowing every permission at once", async () => {
    const { app, desk, laptop } = await launch();
    parkOn(desk, RECEIPTS, {
      kind: "question",
      toolName: "AskUserQuestion",
      input: null,
      summary: "Which database?",
      questions: [{ header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "" }], multiSelect: false }],
    });
    parkOn(laptop, DEPLOY, { summary: "Bash: kubectl apply" });
    parkOn(desk, NOTES, { summary: "Bash: git push" });
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 3, "three prompts parked");
    await openAsks(app);
    expect(app.frame()).toContain("question Which database?");
    await app.press("y");
    await app.waitFor("This one is answered on its own card: Enter opens it.");
    expect(answersSent(desk)).toEqual([]);
    await app.press("a");
    await app.waitFor("Allow all 2 permissions once? y/n");
    await app.press("y");
    await app.waitUntil(() => answersSent(desk).length === 1 && answersSent(laptop).length === 1, "both permissions answered");
    expect([...answersSent(desk), ...answersSent(laptop)].map((p) => p["decision"])).toEqual(["allow", "allow"]);
    await app.waitFor("⚿ 1 prompt is waiting on you");
  });

  it("says so when nothing is parked", async () => {
    const { app } = await launch();
    await app.type("/asks");
    await app.press(KEY.enter);
    await app.waitFor("Nothing needs you.");
  });
});

describe("Ctrl+]", () => {
  it("opens the asks card when more than one session is parked", async () => {
    const { app, desk, laptop } = await launch();
    parkOn(desk, RECEIPTS);
    parkOn(laptop, DEPLOY);
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 2, "both prompts parked");
    await app.press(KEY.ctrlBracket);
    await app.waitFor("⚿ 2 prompts are waiting on you");
  });

  it("goes to the one session parked, and says when nothing else needs you", async () => {
    const { app, laptop } = await launch();
    parkOn(laptop, DEPLOY);
    await app.waitUntil(() => app.runtime().projections.runs.read().parkedAsks.length === 1, "the prompt parked");
    await app.press(KEY.ctrlBracket);
    await app.waitFor("⚿ Permission");
    expect(app.frame()).toContain("Deploy");
    await app.press(KEY.ctrlBracket);
    await app.waitFor("Nothing else needs you.");
  });

  it("goes to a session whose turn finished since it was last on screen when none is parked, and says when nothing needs you", async () => {
    const { app, desk } = await launch();
    await app.press(KEY.ctrlBracket);
    await app.waitFor("Nothing needs you.");
    const { runId } = desk.startRun(NOTES, "Tidy the notes");
    desk.endRun(NOTES, runId);
    await app.tick(2);
    await app.press(KEY.ctrlBracket);
    await app.waitFor("▌ Tidy the notes");
  });
});
