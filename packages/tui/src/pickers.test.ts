import type { AccountUsage } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The pickers and the commands that are the terminal's own for accounts and
 * permissions (docs/specs/tui.md, "Status, usage, pickers" and "Set up: the
 * summary and the pointer"; #147): `/account` with its sign-in, `/model`,
 * `/mode` and `/containment` with the clamp, `/usage`, `/handoff`,
 * `/review`, `/settings` and `/setup`.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const SETH = { provider: "claude", email: "seth@work.test", organisation: null };
const HOME = { provider: "claude", email: "seth@home.test", organisation: null };
const BYPASS = "The agent will act without asking and can do anything this account can, within the containment you chose.";

const reading = (accountId: string, identity: AccountUsage["identity"], windows: AccountUsage["windows"], unavailableReason: string | null = null): AccountUsage => ({
  accountId,
  identity,
  windows,
  readAt: "2026-09-25T09:00:00.000Z",
  unavailableReason,
});
const window = (name: string, utilisation: number, verdict: "rejected" | null = null, observedAt = "2026-09-25T09:00:00.000Z") => ({
  window: name,
  utilisation,
  resetsAt: "2026-09-25T14:30:00.000Z",
  verdict,
  observedAt,
});

const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  accounts: [
    { id: "account-1", label: "work", identity: SETH },
    { id: "account-2", label: "personal", identity: HOME },
  ],
  sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4", mode: "acceptEdits" }],
  ...extra,
});

/**
 * The terminal on `environments`, the session opened at launch unless `session` is false; under 100 columns, so the
 * rail is not drawn beside the cards and a line a card wraps reads whole.
 */
const launch = async (environments: readonly ScriptedEnvironment[] = [desk()], session = true) => {
  const app = await renderApp({ script: { environments }, size: { columns: 99, rows: 30 }, ...(session && { flags: { session: SESSION } }) });
  apps.push(app);
  await app.waitFor(session ? "Nothing said yet." : "No session is open.");
  return { app, env: app.environment("desk") };
};

/** Types a command into the composer and sends it. */
const command = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

describe("/account", () => {
  it("lists the session's environment's accounts with their identity, sign-in status and plan reading, then 'add an account'", async () => {
    const { app, env } = await launch([
      desk({
        accounts: [
          { id: "account-1", label: "work", identity: SETH },
          { id: "account-2", label: "personal", identity: HOME, status: { state: "expired", checkedAt: null, detail: null } },
        ],
      }),
    ]);
    env.setUsage([reading("account-1", SETH, [window("five_hour", 0.42), window("seven_day", 0.1)]), reading("account-2", HOME, [], "Not signed in.")]);
    await command(app, "/account");
    await app.waitFor("Accounts on desk");
    await app.waitFor("5hr 42% · Week 10%");
    // Each account's row, and its plan reading on the line under it.
    const rows = app.rows();
    const work = rows.findIndex((row) => row.includes("› work"));
    expect(rows[work]).toMatch(/› work\s+seth@work\.test\s+signed in\s+this session/);
    expect(rows[work + 1]).toContain("5hr 42% · Week 10%");
    const personal = rows.findIndex((row) => row.includes("personal"));
    expect(rows[personal]).toMatch(/personal\s+seth@home\.test\s+sign-in expired/);
    expect(rows[personal + 1]).toContain("Not signed in.");
    expect(app.frame()).toContain("+ Add an account");
  });

  it("adds an account: the environment publishes the URL, the terminal takes the code, the fallback command underneath, and the end is one line", async () => {
    const { app, env } = await launch();
    await command(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Label for the new account:");
    await app.type("side");
    await app.press(KEY.enter);
    await app.waitFor("Starting the sign-in");
    expect(env.requests("accounts.add").map((r) => r.params)).toEqual([expect.objectContaining({ label: "side" })]);

    env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true&state=abc" });
    await app.waitFor("https://claude.ai/oauth/authorize?code=true&state=abc");
    await app.waitFor("Or run this in a terminal on desk's machine:");
    expect(app.frame()).toContain("CLAUDE_CONFIG_DIR='/home/seth/.agent-harness/accounts/3' claude auth");
    // A code pasted with space around it is trimmed, as the environment asks.
    await app.paste("  abc-123  ");
    await app.press(KEY.enter);
    await app.waitFor("Checking the code");
    expect(env.requests("accounts.signin.code").map((r) => r.params)).toEqual([expect.objectContaining({ accountId: "account-3", code: "abc-123" })]);

    env.signIn("done");
    await app.waitFor("side is signed in on desk.");
    expect(app.frame()).not.toContain("Checking the code");
  });

  it("says a sign-in that failed, expired or was cancelled in one line each", async () => {
    for (const [state, line] of [
      ["failed", "The sign-in of personal failed: the provider's CLI exited 1."],
      ["expired", "The sign-in of personal expired: no code came within ten minutes."],
      ["cancelled", "The sign-in of personal was cancelled."],
    ] as const) {
      const { app, env } = await launch([desk({ accounts: [{ id: "account-1", label: "work", identity: SETH }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
      await command(app, "/account");
      await app.waitFor("+ Add an account");
      // Enter on an account that is not signed in signs it in.
      await app.press(KEY.down, KEY.enter);
      await app.waitFor("Starting the sign-in");
      expect(env.requests("accounts.signin.start").map((r) => r.params)).toEqual([expect.objectContaining({ accountId: "account-2" })]);
      env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true" });
      await app.waitFor("Then paste the code");
      env.signIn(state, { error: state === "failed" ? "the provider's CLI exited 1" : state === "expired" ? "no code came within ten minutes" : null });
      await app.waitFor(line);
      expect(app.rows().filter((row) => row.includes("personal")).length).toBe(1);
      await app.unmount();
      apps = apps.filter((a) => a !== app);
    }
  });

  it("says the code is being checked from the moment it is sent, before the environment has answered (PR review)", async () => {
    const { app, env } = await launch();
    await command(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.type("side");
    await app.press(KEY.enter);
    env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true" });
    await app.waitFor("Then paste the code");
    // The environment holds its answer: the sign-in it holds still awaits the code.
    let answer = () => undefined as void;
    env.wire.answer("accounts.signin.code", () => new Promise((resolve) => (answer = () => resolve({ result: { receipt: { status: "accepted", sequence: 999, changed: true } } }))));
    await app.type("abc-123");
    await app.press(KEY.enter);
    await app.waitFor("Checking the code");
    expect(app.frame()).not.toContain("Starting the sign-in");
    expect(app.frame()).toContain("https://claude.ai/oauth/authorize?code=true");
    answer();
  });

  it("leaves a card opened meanwhile alone when a sign-in's start answers late with a refusal (PR review)", async () => {
    const { app, env } = await launch([desk({ accounts: [{ id: "account-1", label: "work", identity: SETH }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
    let refuse = () => undefined as void;
    env.wire.answer(
      "accounts.signin.start",
      () =>
        new Promise((resolve) => {
          refuse = () =>
            resolve({ result: { receipt: { status: "rejected", sequence: 999, changed: false, reason: "conflict", error: { code: "conflict", message: "Another sign-in holds desk.", data: {} } } } });
        }),
    );
    await command(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Starting the sign-in");
    // Alt+H opens the hand-off picker over the sign-in card while its start is on its way.
    await app.press("\u001Bh");
    await app.waitFor("Hand off Receipts on desk");
    refuse();
    await app.waitFor("personal was not signed in: Another sign-in holds desk.");
    expect(app.frame()).toContain("Hand off Receipts on desk");
  });

  it("cancels the sign-in it started when Esc leaves the card", async () => {
    const { app, env } = await launch();
    await command(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.type("side");
    await app.press(KEY.enter);
    env.signIn("awaiting-code", { url: "https://claude.ai/oauth/authorize?code=true" });
    await app.waitFor("Then paste the code");
    await app.press(KEY.esc);
    await app.waitFor("The sign-in of side was cancelled.");
    expect(env.requests("accounts.signin.cancel").map((r) => r.params)).toEqual([expect.objectContaining({ accountId: "account-3" })]);
  });

  it("says why an account cannot be added where accounts.add says the sign-in did not start", async () => {
    const { app } = await launch([desk({ addSignIn: { started: false, message: "Another sign-in holds desk: work's." } })]);
    await command(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.type("side");
    await app.press(KEY.enter);
    await app.waitFor("side was added on desk, but its sign-in did not start: Another sign-in holds desk: work's.");
  });

  it("answers absent with the runtime's reason where this client may not add an account", async () => {
    const { app } = await launch([desk({ scopes: ["read", "sessions:write", "runs:drive"] })]);
    await command(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Cannot add an account on desk: This client was paired with desk without the admin scope.");
  });

  it("says why the accounts could not be read, offering no row, where Enter adds nothing (PR review)", async () => {
    const { app } = await launch([desk({ accountsError: "The account store is locked." })]);
    await command(app, "/account");
    await app.waitFor("The accounts could not be read: The account store is locked.");
    expect(app.frame()).not.toContain("+ Add an account");
    await app.press(KEY.enter);
    await app.tick();
    expect(app.frame()).not.toContain("Label for the new account:");
  });
});

describe("/model", () => {
  const models = [
    {
      accountId: "account-1",
      live: true,
      models: [
        { id: "claude-opus-4", family: "opus", tier: 3, efforts: ["low", "medium", "high"], label: "Opus 4" },
        { id: "claude-haiku-4", family: "haiku", tier: 1, efforts: [], label: null },
      ],
    },
  ];

  it("lists the models the session's account can use with their efforts, and the choice rides the session's next run", async () => {
    const { app, env } = await launch([desk({ models })]);
    await command(app, "/model");
    await app.waitFor("Models for work on desk");
    await app.waitFor("Opus 4 (claude-opus-4)");
    expect(app.rows().find((row) => row.includes("claude-opus-4"))).toMatch(/Opus 4 \(claude-opus-4\)\s+low · medium · high\s+this session/);
    expect(app.frame()).toContain("claude-haiku-4");
    await app.press(KEY.enter);
    await app.waitFor("Effort for Opus 4");
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("The next run of Receipts goes out on claude-opus-4 at high effort.");
    await app.waitFor("claude-opus-4 high ·");

    await app.type("go");
    await app.press(KEY.enter);
    await app.waitFor("▌ go");
    expect(env.requests("runs.start").map((r) => r.params)).toEqual([expect.objectContaining({ text: "go", model: "claude-opus-4", effort: "high" })]);
  });

  it("chooses a model with no effort at once", async () => {
    const { app } = await launch([desk({ models })]);
    await command(app, "/model");
    await app.waitFor("claude-haiku-4");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("The next run of Receipts goes out on claude-haiku-4 at its own effort.");
  });

  it("marks an effort as the session's only on the model the session is on (PR review)", async () => {
    const sonnet = { id: "claude-sonnet-4", family: "sonnet", tier: 2, efforts: ["low", "high"], label: "Sonnet 4" };
    const { app } = await launch([desk({ models: [{ ...models[0], models: [...(models[0]?.models ?? []), sonnet] }] })]);
    await command(app, "/model");
    await app.waitFor("Opus 4 (claude-opus-4)");
    await app.press(KEY.enter);
    await app.waitFor("Effort for Opus 4");
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("The next run of Receipts goes out on claude-opus-4 at high effort.");
    // The session is on Opus 4 at high: Sonnet 4's high is not the session's, nor is its own effort.
    await command(app, "/model");
    await app.waitFor("Sonnet 4 (claude-sonnet-4)");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Effort for Sonnet 4");
    expect(app.rows().find((row) => row.includes("high"))).not.toContain("this session");
    expect(app.rows().find((row) => row.includes("the model's own"))).not.toContain("this session");
    // Opus 4's high still is.
    await app.press(KEY.esc);
    await app.waitFor("Models for work on desk");
    await app.press(KEY.up, KEY.up, KEY.enter);
    await app.waitFor("Effort for Opus 4");
    expect(app.rows().find((row) => row.includes("high"))).toContain("this session");
  });
});

describe("/mode", () => {
  it("greys the modes above the connection's ceiling with the ceiling named, shows the bypass sentence on bypassPermissions, and shows the clamp the answer gives", async () => {
    const { app, env } = await launch([desk({ hello: { ceiling: "auto" } })]);
    await command(app, "/mode");
    await app.waitFor("Mode of Receipts");
    expect(app.rows().find((row) => row.includes("bypassPermissions"))).toContain("above this connection's ceiling (auto)");
    expect(app.rows().find((row) => row.includes("acceptEdits"))).toContain("this session");
    await app.press(KEY.down, KEY.down, KEY.down);
    // The sentence under the list while the cursor is on bypassPermissions, wrapped to the card.
    await app.waitFor(BYPASS);
    await app.press(KEY.enter);
    await app.waitFor("Asked for bypassPermissions; Receipts has auto: clamped to this connection's ceiling (auto).");
    expect(env.requests("permissions.mode.set").map((r) => r.params)).toEqual([expect.objectContaining({ sessionId: SESSION, mode: "bypassPermissions" })]);
    await app.waitFor("⏸ auto");
  });

  it("marks the attended default, acceptEdits lowered to the ceiling, as the session's mode and opens on it when the session has none of its own (PR review)", async () => {
    const { app } = await launch([desk({ hello: { ceiling: "plan" }, sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4" }] })]);
    await app.waitFor("⏸ plan");
    await command(app, "/mode");
    await app.waitFor("Mode of Receipts");
    const plan = app.rows().find((row) => row.includes("plan") && !row.includes("Mode of"));
    expect(plan).toContain("› plan");
    expect(plan).toContain("this session");
    expect(app.rows().find((row) => row.includes("acceptEdits"))).toContain("above this connection's ceiling (plan)");
  });

  it("sets bypassPermissions where the ceiling allows it, with the sentence", async () => {
    const { app } = await launch();
    await command(app, "/mode");
    await app.waitFor("Mode of Receipts");
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor(`Mode: bypassPermissions. ${BYPASS}`);
    await app.waitFor("⏵⏵ BYPASS");
  });
});

describe("/containment", () => {
  const containment = {
    levels: [
      { level: "off" as const, available: true as const, reason: null, cause: null },
      { level: "workspace" as const, available: true as const, reason: null, cause: null },
      { level: "workspace-no-network" as const, available: false as const, reason: "socat is not installed", cause: "socat_missing" as const },
    ],
  };

  it("greys the levels the probe says cannot be enforced, with its reason, and sets the one chosen", async () => {
    const { app, env } = await launch([desk({ containment })]);
    await command(app, "/containment");
    await app.waitFor("Containment of Receipts");
    await app.waitFor("not available here: socat is not installed");
    expect(app.rows().find((row) => row.includes("off"))).toContain("the default");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Containment: workspace, from the next run of Receipts.");
    expect(env.requests("permissions.containment.set").map((r) => r.params)).toEqual([expect.objectContaining({ sessionId: SESSION, level: "workspace" })]);
    await app.waitFor("◐ workspace");
  });

  it("says containment_unavailable in one line", async () => {
    const { app } = await launch([desk({ containment })]);
    await command(app, "/containment");
    await app.waitFor("not available here");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("workspace-no-network cannot be enforced on desk: socat is not installed");
  });
});

describe("/usage", () => {
  it("shows the plan windows per account identity, pooled across environments, and why an account has none", async () => {
    const { app, env } = await launch([desk(), { name: "laptop", reach: "paired", accounts: [{ id: "account-9", label: "work", identity: SETH }] }]);
    env.setUsage([reading("account-1", SETH, [window("five_hour", 0.42), window("seven_day", 0.1)]), reading("account-2", HOME, [], "Not signed in.")]);
    // The laptop observed the 5-hour window later: the pooled gauge takes its reading, a refusal.
    app.environment("laptop").setUsage([reading("account-9", SETH, [window("five_hour", 0.61, "rejected", "2026-09-25T09:05:00.000Z")])]);
    await command(app, "/usage");
    await app.waitFor("Plan usage");
    await app.waitFor("seth@work.test · work on desk, work on laptop");
    await app.waitFor(/5-hour\s+█*░* ?61% out\s+resets \d\d:\d\d/);
    expect(app.frame()).toMatch(/Week\s+█*░* ?10%/);
    expect(app.frame()).toContain("seth@home.test · personal on desk");
    expect(app.frame()).toContain("Not signed in.");
  });
});

describe("/handoff", () => {
  it("opens the account picker for this session's next run on its environment, each with its plan reading, and hands off by forking onto the account chosen", async () => {
    const { app, env } = await launch([desk({ recommendation: { accountId: "account-2", reason: "most-room", message: "personal has the most room.", candidates: 1 } })]);
    env.setUsage([reading("account-1", SETH, [window("five_hour", 0.95)]), reading("account-2", HOME, [window("five_hour", 0.12)])]);
    await command(app, "/handoff");
    await app.waitFor("Hand off Receipts on desk");
    await app.waitFor("personal has the most room.");
    await app.waitFor("5hr 12%");
    // The cursor starts on the account the environment recommends.
    expect(app.rows().find((row) => row.includes("personal"))).toContain("› personal");
    await app.waitFor("hand-off between environments comes in milestone 2 (ADR 0005)");
    await app.press(KEY.enter);
    await app.waitFor("Handed off to personal: a new session forked from Receipts runs on it; Receipts stays as it is.");
    expect(env.requests("sessions.fork").map((r) => r.params)).toEqual([expect.objectContaining({ sessionId: SESSION, account: "account-2" })]);
    // The fork is open, on the row naming where it came from, and its first run is the chosen account's.
    const fork = String(env.requests("sessions.fork")[0]?.params?.["id"]);
    await app.waitFor("Forked from Receipts");
    await app.type("carry on");
    await app.press(KEY.enter);
    await app.waitUntil(() => env.summary(fork).accountId === "account-2", "the fork's run on personal");
    expect(env.liveRun(SESSION)).toBeUndefined();
  });

  it("answers absent with the reason for another environment", async () => {
    const { app } = await launch([desk(), { name: "laptop", reach: "paired" }]);
    await command(app, "/handoff laptop");
    await app.waitFor("Not handed off to laptop: hand-off between environments comes in milestone 2 (ADR 0005).");
  });

  it("hands off from no account card on an environment other than the open session's (PR review)", async () => {
    // The session is open on laptop; laptop is removed, so /account falls back to desk, the one environment left.
    const { app, env } = await launch([desk({ sessions: [] }), { ...desk(), name: "laptop", reach: "paired" }]);
    await command(app, "/environment");
    await app.press(KEY.down, KEY.enter);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Remove laptop?");
    await app.press("y");
    await app.waitFor("Removed laptop");
    await app.press(KEY.esc);
    await command(app, "/account");
    await app.waitFor("Accounts on desk");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Not handed off to desk: hand-off between environments comes in milestone 2 (ADR 0005).");
    expect(env.requests("sessions.fork")).toEqual([]);
  });

  it("says in its hint that Enter signs in an account not signed in, as it does (PR review)", async () => {
    const { app } = await launch();
    await command(app, "/handoff");
    await app.waitFor("Hand off Receipts on desk");
    expect(app.frame()).toMatch(/hands off or signs in/);
  });

  it("says the session is on the account already", async () => {
    const { app } = await launch();
    await command(app, "/handoff");
    await app.waitFor("Hand off Receipts on desk");
    await app.press(KEY.enter);
    await app.waitFor("Receipts runs on work already.");
  });
});

describe("/review", () => {
  it("renders the Unattended review: each run, who ran it, its mode and containment, its calls counted and each denial", async () => {
    const { app } = await launch([
      desk({
        review: [
          {
            actor: { kind: "routine", name: "nightly" },
            counts: { toolCalls: 3, autoApproved: 2, denied: 1, answeredByPerson: 0, expired: 0 },
            denials: [{ toolCallId: "t1", tool: "Bash", summary: "rm -rf /tmp/cache", decidedBy: "denylist", reason: "the command matches the denylist" }],
          },
        ],
      }),
    ]);
    await command(app, "/review");
    await app.waitFor("To review on desk");
    await app.waitFor("Receipts · routine nightly · unattended · acceptEdits · workspace");
    expect(app.frame()).toContain("3 calls: 2 auto-approved, 1 denied, 0 by a person, 0 expired");
    await app.waitFor("denied Bash: rm -rf /tmp/cache (denylist: the command matches the denylist)");
  });

  it("says when there is nothing to review", async () => {
    const { app } = await launch();
    await command(app, "/review");
    await app.waitFor("Nothing to review: no run since the review was last seen.");
  });
});

describe("/settings", () => {
  it("renders every key of the settings schema by its type", async () => {
    const { app } = await launch([desk({ settings: { "sessions.autoSettleOnMerge": true } })]);
    await command(app, "/settings");
    await app.waitFor("Settings on desk");
    const frame = app.frame();
    expect(frame).toMatch(/accounts\.defaultAccount\s+none/);
    expect(frame).toMatch(/providers\.processIdleMinutes\s+30/);
    expect(frame).toMatch(/permissions\.defaultCeiling\s+acceptEdits/);
    expect(frame).toMatch(/permissions\.parkedPrompt\.ttl\s+24 hours/);
    expect(frame).toMatch(/permissions\.unattended\.bypassAcknowledgedAt\s+none\s+read-only/);
    // Down to the Service row's keys, past the four, five, nine, two and five of the rows above it.
    await app.press(...Array.from({ length: 25 }, () => KEY.down));
    await app.waitFor(/sessions\.autoSettleAfterIdle\s+14 days/);
    // The key under the cursor says what it is.
    expect(app.frame()).toContain("How long a session is quiet before auto-settle settles it");
    // The list scrolls with the cursor, to the key the environment holds changed.
    await app.press(KEY.down);
    await app.waitFor(/sessions\.autoSettleOnMerge\s+on/);
  });

  it("flips a switch, picks a choice and takes a typed value, each through the method that writes the key", async () => {
    const { app, env } = await launch();
    await command(app, "/settings");
    await app.waitFor("Settings on desk");
    // A typed value, checked against the key's schema before it is sent.
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("New value for providers.processIdleMinutes (now 30)");
    // The value being typed holds its key: ↓ moves nothing.
    await app.press(KEY.down);
    await app.type("5000");
    await app.press(KEY.enter);
    await app.waitFor(/Not saved: providers\.processIdleMinutes: .*1440/);
    // What was typed stays, to be put right.
    await app.press(KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace);
    await app.type("45");
    await app.press(KEY.enter);
    await app.waitFor("providers.processIdleMinutes is 45.");
    expect(env.requests("settings.update").map((r) => r.params)).toContainEqual(expect.objectContaining({ values: { "providers.processIdleMinutes": 45 } }));
    // A choice, through the permission settings' own method.
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("permissions.defaultCeiling:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("permissions.defaultCeiling is auto.");
    expect(env.requests("permissions.settings.set").map((r) => r.params)).toEqual([expect.objectContaining({ values: { "permissions.defaultCeiling": "auto" } })]);
    // A switch flips on Enter: down past the rest of Permissions, Browser, Key managers and Your machines to the Service row's second key.
    await app.press(...Array.from({ length: 22 }, () => KEY.down), KEY.enter);
    await app.waitFor("sessions.autoSettleOnMerge is on.");
    expect(env.settings()["sessions.autoSettleOnMerge"]).toBe(true);
  });

  it("writes an update key through updates.settings.set, the one method that writes it (#335)", async () => {
    const { app, env } = await launch();
    await command(app, "/settings environments.machines");
    await app.waitFor("Settings on desk");
    // The Your machines row: updates.autoUpdate, then updates.channel.
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("updates.channel:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("updates.channel is beta.");
    expect(env.requests("updates.settings.set").map((r) => r.params)).toEqual([expect.objectContaining({ values: { "updates.channel": "beta" } })]);
    expect(env.requests("settings.update")).toEqual([]);
    expect(env.settings()["updates.channel"]).toBe("beta");
  });

  it("asks with the bypass sentence before the unattended mode becomes bypassPermissions", async () => {
    const { app, env } = await launch();
    await command(app, "/settings access.permissions");
    await app.waitFor("Settings on desk");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("permissions.unattended.mode:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor(`${BYPASS} Make bypassPermissions the unattended mode? y/n`);
    await app.press("y");
    await app.waitFor("permissions.unattended.mode is bypassPermissions.");
    expect(env.requests("permissions.settings.set").map((r) => r.params)).toEqual([
      expect.objectContaining({ values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true }),
    ]);
  });

  it("is read-only without the admin scope, saying why", async () => {
    const { app, env } = await launch([desk({ scopes: ["read", "sessions:write", "runs:drive"] })]);
    await command(app, "/settings");
    await app.waitFor("read-only: This client was paired with desk without the admin scope.");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Not changed: This client was paired with desk without the admin scope.");
    expect(env.requests("settings.update")).toEqual([]);
  });

  it("takes no paste into a value being typed while a question is asked (PR review)", async () => {
    const { app } = await launch();
    await command(app, "/settings");
    await app.waitFor("Settings on desk");
    await app.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("permissions.unattended.mode:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Make bypassPermissions the unattended mode? y/n");
    // The question stands while the list below it opens a value to type.
    await app.press(KEY.up, KEY.up, KEY.enter);
    await app.waitFor("New value for providers.processIdleMinutes (now 30)");
    expect(app.frame()).toContain("Make bypassPermissions the unattended mode? y/n");
    await app.paste("45");
    await app.tick();
    expect(app.frame()).not.toMatch(/as JSON or a bare word: 45/);
  });

  it("leaves another environment's settings card alone when a write answers after its own card closed (PR review)", async () => {
    const { app, env } = await launch([desk(), { name: "laptop", reach: "paired", sessions: [{ title: "Deploy" }] }]);
    let saved = () => undefined as void;
    env.wire.answer("settings.update", () => new Promise((resolve) => (saved = () => resolve({ result: { receipt: { status: "accepted", sequence: 999, changed: true } } }))));
    await command(app, "/settings environments.service");
    await app.waitFor("Settings on desk");
    await app.press(KEY.down, KEY.enter);
    await app.waitUntil(() => env.requests("settings.update").length === 1, "the switch's write on desk");
    await app.press(KEY.esc);
    // The laptop's session open, /settings is the laptop's.
    await command(app, "/resume");
    await app.type("Deploy");
    await app.press(KEY.enter);
    await app.waitFor("● laptop");
    await command(app, "/settings environments.service");
    await app.waitFor("Settings on laptop");
    await app.waitFor(/sessions\.autoSettleOnMerge\s+off/);
    saved();
    await app.waitFor("sessions.autoSettleOnMerge is on.");
    expect(app.frame()).toMatch(/sessions\.autoSettleOnMerge\s+off/);
  });
});

describe("/settings by row (#389)", () => {
  /** The frame's lines, each without its leading spaces and cursor mark or its trailing spaces. */
  const linesOf = (frame: string) => frame.split("\n").map((line) => line.replace(/^[\s›]+/, "").trimEnd());

  it("lists the keys under their rows' labels, the rows in the rail's order", async () => {
    const { app } = await launch();
    await command(app, "/settings");
    await app.waitFor("Settings on desk");
    // The first row with keys heads the list, the key under the cursor described.
    expect(app.frame()).toMatch(/Default account and model\n.*accounts\.defaultAccount\s+none/);
    expect(app.frame()).toContain("The account a session with none of its own runs on");
    // Down the list, each row's label over its keys: Permissions, then Browser, then Key managers, then Your machines, then Service.
    await app.press(...Array.from({ length: 27 }, () => KEY.down));
    await app.waitFor(/sessions\.transcriptCompactAfterDays\s+90/);
    const lines = linesOf(app.frame());
    const at = (text: string) => lines.findIndex((line) => line.startsWith(text));
    expect(at("browser.internalHosts")).toBeGreaterThan(-1);
    expect(at("Key managers")).toBe(at("browser.internalHosts") + 1);
    expect(lines.slice(at("Key managers") + 1, at("Key managers") + 3).map((line) => line.split(/\s+/)[0])).toEqual(["credentials.injection", "credentials.injectionByAccount"]);
    expect(at("Your machines")).toBe(at("credentials.injectionByAccount") + 1);
    expect(at("updates.autoUpdate")).toBe(at("Your machines") + 1);
    expect(at("Service")).toBeGreaterThan(at("updates.deferralCapHours"));
    expect(lines.slice(at("Service") + 1, at("Service") + 4).map((line) => line.split(/\s+/)[0])).toEqual([
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
    ]);
  });

  it("opens on a row's keys alone by its id, each written through the method that writes it", async () => {
    const { app, env } = await launch();
    await command(app, "/settings access.permissions");
    await app.waitFor("Settings on desk");
    await app.waitFor(/permissions\.defaultCeiling\s+acceptEdits/);
    const frame = app.frame();
    expect(frame).toContain("Permissions");
    expect(frame).toMatch(/permissions\.containment\.default\s+off/);
    expect(frame).not.toContain("accounts.defaultAccount");
    expect(frame).not.toContain("updates.channel");
    // The cursor starts on the row's first key.
    await app.press(KEY.enter);
    await app.waitFor("permissions.defaultCeiling:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("permissions.defaultCeiling is auto.");
    expect(env.requests("permissions.settings.set").map((r) => r.params)).toEqual([expect.objectContaining({ values: { "permissions.defaultCeiling": "auto" } })]);
  });

  it("opens the Service row on the session keys the Your machines step writes, and flips one there", async () => {
    const { app, env } = await launch();
    await command(app, "/settings environments.service");
    await app.waitFor(/sessions\.autoSettleOnMerge\s+off/);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("sessions.autoSettleOnMerge is on.");
    expect(env.settings()["sessions.autoSettleOnMerge"]).toBe(true);
  });

  it("says when a row holds no settings key, and when no row has the id, naming those that hold keys", async () => {
    const { app } = await launch();
    await command(app, "/settings about.about");
    await app.waitFor("About holds no settings key.");
    await app.press(KEY.esc);
    await command(app, "/settings secrets");
    await app.waitFor(
      "No settings row is named secrets. The rows holding settings: accounts.default-model, access.permissions, access.browser, access.key-managers, environments.machines, environments.service, appearance.theme.",
    );
  });
});

describe("/setup", () => {
  it("answers absent with the reason until the environment has a step-registry query, and points at the desktop window", async () => {
    const { app } = await launch(undefined, false);
    await command(app, "/setup");
    await app.waitFor(
      "Set up on desk cannot be read from here yet: no step-registry query is on the wire (setup.check and the setup subscription, ADR 0031). Run it in the desktop window.",
    );
  });

  it("names the environment asked for, and says when none is known by that name", async () => {
    const { app } = await launch([desk(), { name: "laptop", reach: "paired" }], false);
    await command(app, "/setup laptop");
    await app.waitFor("Set up on laptop cannot be read from here yet");
    await command(app, "/setup attic");
    await app.waitFor("No environment named attic is known here.");
  });
});
