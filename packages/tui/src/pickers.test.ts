import { STEP_ORDER, type AccountUsage } from "@agent-harness/contracts";
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
const MILO = { provider: "claude", email: "milo@work.test", organisation: null };
const HOME = { provider: "claude", email: "milo@home.test", organisation: null };
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
    { id: "account-1", label: "work", identity: MILO },
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
          { id: "account-1", label: "work", identity: MILO },
          { id: "account-2", label: "personal", identity: HOME, status: { state: "expired", checkedAt: null, detail: null } },
        ],
      }),
    ]);
    env.setUsage([reading("account-1", MILO, [window("five_hour", 0.42), window("seven_day", 0.1)]), reading("account-2", HOME, [], "Not signed in.")]);
    await command(app, "/account");
    await app.waitFor("Accounts on desk");
    await app.waitFor("5-hour 42% · Weekly 10%");
    // Each account's row, and its plan reading on the line under it.
    const rows = app.rows();
    const work = rows.findIndex((row) => row.includes("› work"));
    expect(rows[work]).toMatch(/› work\s+milo@work\.test\s+signed in\s+this session/);
    expect(rows[work + 1]).toContain("5-hour 42% · Weekly 10%");
    const personal = rows.findIndex((row) => row.includes("personal"));
    expect(rows[personal]).toMatch(/personal\s+milo@home\.test\s+sign-in expired/);
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
    expect(app.frame()).toContain("CLAUDE_CONFIG_DIR='/home/milo/.agent-harness/accounts/3' claude auth");
    // A code pasted with space around it is trimmed, as the environment asks.
    await app.paste("  abc-123  ");
    await app.press(KEY.enter);
    await app.waitFor("Checking the code");
    expect(env.requests("accounts.signin.code").map((r) => r.params)).toEqual([expect.objectContaining({ accountId: "account-3", code: "abc-123" })]);

    env.signIn("done");
    await app.waitFor("side is signed in on desk.");
    expect(app.frame()).not.toContain("Checking the code");
    await app.waitUntil(() => env.requests("setup.check").length >= 2, "the account checks after sign-in writes");
    expect(env.requests("setup.check").every((r) => r.params.step === "account")).toBe(true);
  });

  it("says a sign-in that failed, expired or was cancelled in one line each", async () => {
    for (const [state, line] of [
      ["failed", "The sign-in of personal failed: the provider's CLI exited 1."],
      ["expired", "The sign-in of personal expired: no code came within ten minutes."],
      ["cancelled", "The sign-in of personal was cancelled."],
    ] as const) {
      const { app, env } = await launch([desk({ accounts: [{ id: "account-1", label: "work", identity: MILO }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
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
    const { app, env } = await launch([desk({ accounts: [{ id: "account-1", label: "work", identity: MILO }, { id: "account-2", label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }] })]);
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
    await app.waitUntil(() => env.requests("setup.check").length === 1, "the mode's Permissions check");
    expect(env.requests("setup.check")[0]?.params).toEqual({ step: "permissions" });
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

  it("checks Permissions only after this terminal's containment receipt", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"], containment })]);
    let receipt: (() => void) | undefined;
    env.wire.answer("permissions.containment.set", () => new Promise((resolve) => {
      receipt = () => resolve({ result: { receipt: { status: "accepted", sequence: 0, changed: false } } });
    }));
    await command(app, "/containment");
    await app.waitFor("Containment of Receipts");
    await app.press(KEY.down, KEY.enter);
    await app.waitUntil(() => receipt !== undefined, "the containment write");
    expect(env.requests("setup.check")).toEqual([]);
    receipt?.();
    await app.waitUntil(() => env.requests("setup.check").length === 1, "Permissions checked after the receipt");
    expect(env.requests("setup.check").map((r) => r.params)).toEqual([{ step: "permissions" }]);
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
  it("leaves unknown limits out of the status meter and names them once in usage details", async () => {
    const { app, env } = await launch();
    env.setUsage([reading("account-1", MILO, [window("five_hour", 0.42), window("iguana_necktie", 0.37)])]);
    await app.waitFor("5-hour");
    expect(app.frame()).not.toMatch(/iguana[_ ]necktie|Other limit|37%/);
    await command(app, "/usage");
    await app.waitFor(/Other limit\s+█*░* ?37%\s+resets/);
    expect(app.frame().match(/Other limit/g)).toHaveLength(1);
    expect(app.frame()).not.toMatch(/iguana[_ ]necktie/);
  });

  it("shows the plan windows per account identity, pooled across environments, and why an account has none", async () => {
    const { app, env } = await launch([desk(), { name: "laptop", reach: "paired", accounts: [{ id: "account-9", label: "work", identity: MILO }] }]);
    env.setUsage([reading("account-1", MILO, [window("five_hour", 0.42), window("seven_day", 0.1)]), reading("account-2", HOME, [], "Not signed in.")]);
    // The laptop observed the 5-hour window later: the pooled gauge takes its reading, a refusal.
    app.environment("laptop").setUsage([reading("account-9", MILO, [window("five_hour", 0.61, "rejected", "2026-09-25T09:05:00.000Z")])]);
    await command(app, "/usage");
    await app.waitFor("Plan usage");
    await app.waitFor("milo@work.test · work on desk, work on laptop");
    await app.waitFor(/5-hour\s+█*░* ?61% out\s+resets \d\d:\d\d/);
    expect(app.frame()).toMatch(/Weekly\s+█*░* ?10%/);
    expect(app.frame()).toContain("milo@home.test · personal on desk");
    expect(app.frame()).toContain("scroll");
    expect(app.frame()).not.toContain("runs the action");
    expect(app.frame()).not.toContain("next action");
    expect(app.frame()).toContain("Not signed in.");
  });
});

describe("/handoff", () => {
  it("opens the account picker for this session's next run on its environment, each with its plan reading, and hands off by forking onto the account chosen", async () => {
    const { app, env } = await launch([desk({ recommendation: { accountId: "account-2", reason: "most-room", message: "personal has the most room.", candidates: 1 } })]);
    env.setUsage([reading("account-1", MILO, [window("five_hour", 0.95)]), reading("account-2", HOME, [window("five_hour", 0.12)])]);
    await command(app, "/handoff");
    await app.waitFor("Hand off Receipts on desk");
    await app.waitFor("personal has the most room.");
    await app.waitFor("5-hour 12%");
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
    expect(frame).toMatch(/Default account\s+none/);
    expect(frame).toMatch(/Stop idle agent processes after minutes\s+30/);
    expect(frame).toMatch(/Maximum permission mode\s+acceptEdits/);
    expect(frame).toMatch(/Unanswered permission timeout\s+24 hours/);
    expect(frame).toMatch(/Permission bypass acknowledged\s+none\s+read-only/);
    // Down to the Service row's keys, past the four, one, five, nine, two and seven of the rows above it.
    await app.press(...Array.from({ length: 28 }, () => KEY.down));
    await app.waitFor(/Settle idle sessions\s+14 days/);
    // The key under the cursor says what it is.
    expect(app.frame()).toContain("Move quiet sessions out of the active list after this long.");
    // The list scrolls with the cursor, to the key the environment holds changed.
    await app.press(KEY.down);
    await app.waitFor(/Settle sessions after merge\s+on/);
  });

  it("flips a switch, picks a choice and takes a typed value, each through the method that writes the key", async () => {
    const { app, env } = await launch();
    await command(app, "/settings");
    await app.waitFor("Settings on desk");
    // A typed value, checked against the key's schema before it is sent.
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("New value for Stop idle agent processes after minutes (now 30)");
    // The value being typed holds its key: ↓ moves nothing.
    await app.press(KEY.down);
    await app.type("5000");
    await app.press(KEY.enter);
    await app.waitFor(/Not saved: providers\.processIdleMinutes: .*1440/);
    // What was typed stays, to be put right.
    await app.press(KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace);
    await app.type("45");
    await app.press(KEY.enter);
    await app.waitFor("Stop idle agent processes after minutes is 45.");
    expect(env.requests("settings.update").map((r) => r.params)).toContainEqual(expect.objectContaining({ values: { "providers.processIdleMinutes": 45 } }));
    // A choice, through the permission settings' own method, past the Instructions row's switch.
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Maximum permission mode:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Maximum permission mode is auto.");
    expect(env.requests("permissions.settings.set").map((r) => r.params)).toEqual([expect.objectContaining({ values: { "permissions.defaultCeiling": "auto" } })]);
    // A switch flips on Enter: down past the rest of Permissions, Browser, Key managers and Your machines to the Service row's second key.
    await app.press(...Array.from({ length: 24 }, () => KEY.down), KEY.enter);
    await app.waitFor("Settle sessions after merge is on.");
    expect(env.settings()["sessions.autoSettleOnMerge"]).toBe(true);
  });

  it("writes an update key through updates.settings.set, the one method that writes it (#335)", async () => {
    const { app, env } = await launch();
    await command(app, "/settings environments.machines");
    await app.waitFor("Settings on desk");
    // The Your machines row: updates.autoUpdate, then updates.channel.
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Update channel:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Update channel is beta.");
    expect(env.requests("updates.settings.set").map((r) => r.params)).toEqual([expect.objectContaining({ values: { "updates.channel": "beta" } })]);
    expect(env.requests("settings.update")).toEqual([]);
    expect(env.settings()["updates.channel"]).toBe("beta");
  });

  it("asks with the bypass sentence before the unattended mode becomes bypassPermissions", async () => {
    const { app, env } = await launch();
    await command(app, "/settings access.permissions");
    await app.waitFor("Settings on desk");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Unattended permission mode:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor(`${BYPASS} Make bypassPermissions the unattended mode? y/n`);
    await app.press("y");
    await app.waitFor("Unattended permission mode is bypassPermissions.");
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
    await app.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Unattended permission mode:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Make bypassPermissions the unattended mode? y/n");
    // The question stands while the list below it opens a value to type.
    await app.press(KEY.up, KEY.up, KEY.up, KEY.enter);
    await app.waitFor("New value for Stop idle agent processes after minutes (now 30)");
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
    await app.waitFor("LA laptop");
    await command(app, "/settings environments.service");
    await app.waitFor("Settings on laptop");
    await app.waitFor(/Settle sessions after merge\s+off/);
    saved();
    await app.waitFor("Settle sessions after merge is on.");
    expect(app.frame()).toMatch(/Settle sessions after merge\s+off/);
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
    expect(app.frame()).toMatch(/Default account and model\n.*Default account\s+none/);
    expect(app.frame()).toContain("The account to use when a session has no account of its own.");
    // Down the list, each row's label over its keys: Instructions, then Permissions, then Browser, then Key managers, then Your machines, then Service.
    await app.press(...Array.from({ length: 30 }, () => KEY.down));
    await app.waitFor(/Compact quiet transcripts after days\s+90/);
    const lines = linesOf(app.frame());
    const at = (text: string) => lines.findIndex((line) => line.startsWith(text));
    expect(at("Allowed internal hosts")).toBeGreaterThan(-1);
    expect(at("Key managers")).toBe(at("Allowed internal hosts") + 1);
    expect(lines.slice(at("Key managers") + 1, at("Key managers") + 3).map((line) => line.split(/\s{2,}/)[0])).toEqual(["Provide credentials to agents", "Credential access by account"]);
    expect(at("Your machines")).toBe(at("Credential access by account") + 1);
    expect(at("Automatic updates")).toBe(at("Your machines") + 1);
    // The two binding keys after the update keys on Your machines (#574).
    expect(lines.slice(at("Maximum update delay in hours") + 1, at("Maximum update delay in hours") + 3).map((line) => line.split(/\s{2,}/)[0])).toEqual(["Allow tailnet connections", "Local network address"]);
    expect(at("Service")).toBe(at("Local network address") + 1);
    expect(lines.slice(at("Service") + 1, at("Service") + 4).map((line) => line.split(/\s{2,}/)[0])).toEqual([
      "Settle idle sessions",
      "Settle sessions after merge",
      "Compact quiet transcripts after days",
    ]);
  });

  it("opens on a row's keys alone by its id, each written through the method that writes it", async () => {
    const { app, env } = await launch();
    await command(app, "/settings access.permissions");
    await app.waitFor("Settings on desk");
    await app.waitFor(/Maximum permission mode\s+acceptEdits/);
    const frame = app.frame();
    expect(frame).toContain("Permissions");
    expect(frame).toMatch(/Default process containment\s+off/);
    expect(frame).not.toContain("accounts.defaultAccount");
    expect(frame).not.toContain("updates.channel");
    // The cursor starts on the row's first key.
    await app.press(KEY.enter);
    await app.waitFor("Maximum permission mode:");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Maximum permission mode is auto.");
    expect(env.requests("permissions.settings.set").map((r) => r.params)).toEqual([expect.objectContaining({ values: { "permissions.defaultCeiling": "auto" } })]);
  });

  it("opens the Service row on the session keys the Your machines step writes, and flips one there", async () => {
    const { app, env } = await launch();
    await command(app, "/settings environments.service");
    await app.waitFor(/Settle sessions after merge\s+off/);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Settle sessions after merge is on.");
    expect(env.settings()["sessions.autoSettleOnMerge"]).toBe(true);
  });

  it("says when a row holds no settings key, and when no row has the id, naming those that hold keys", async () => {
    const { app } = await launch();
    await command(app, "/settings about.about");
    await app.waitFor("About holds no settings key.");
    await app.press(KEY.esc);
    await command(app, "/settings secrets");
    await app.waitFor(
      "No settings row is named secrets. The rows holding settings: accounts.default-model, knowledge.instructions, access.permissions, access.browser, access.key-managers, environments.machines, environments.service, appearance.theme.",
    );
  });
});

describe("/setup", () => {
  it("draws only registered steps from the snapshot without a check", async () => {
    const { app, env } = await launch([desk({
      capabilities: ["setup"],
      setup: {
        account: { state: "done" },
        browser: { state: "skipped" },
        permissions: { state: "needs-attention", reason: "The denylist could not be read." },
        "memory-bank": null,
        skills: null,
      },
    })]);
    await app.waitFor("Set up on desk: 7 of 9 done, 1 need attention (Permissions). Run it in the desktop window.");
    await command(app, "/setup");
    await app.waitFor(/Account.*done/);
    await app.waitFor("Choose your agent’s account");
    // Outcome hints make rows two lines; move to the steps below the fold.
    for (let row = 0; row < 6; row++) await app.press(KEY.down);
    await app.waitFor(/Browser.*skipped/);
    await app.waitFor("See and use web pages");
    await app.press(KEY.down);
    await app.waitFor(/Permissions.*needs attention.*The denylist could not be read\./);
    await app.waitFor("7 done, 1 needs attention, 1 skipped");
    expect(app.frame()).not.toContain("Memory bank:");
    expect(app.frame()).not.toContain("Skills:");
    expect(env.requests("setup.check")).toEqual([]);
  });

  it("shows a pending scheduled read as checking with no attention header, then follows its first read", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"], setup: {
      ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
      "your-machines": { state: "pending", reason: "Waiting for the first release channel read." },
    } })]);
    await command(app, "/setup");
    await app.waitFor("Your machines: checking — Waiting for the first release channel read.");
    await app.waitFor("0 done, 0 need attention, 0 skipped, 1 checking");
    expect(app.frame()).not.toContain("need attention (Your machines)");
    env.setSetup({ "your-machines": { state: "done" } });
    env.passSetup(["your-machines"]);
    await app.waitFor("Your machines: done");
    await app.waitFor("1 done, 0 need attention, 0 skipped");
    expect(env.requests("setup.check")).toEqual([]);
  });

  it("updates the open card from the environment's setup notices without another check", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"] })]);
    await command(app, "/setup");
    for (let row = 0; row < 9; row++) await app.press(KEY.down);
    await app.waitFor(/Permissions.*done/);
    env.setSetup({ permissions: { state: "needs-attention", reason: "Containment is unavailable." } });
    env.passSetup(["permissions"]);
    await app.waitFor(/Permissions.*needs attention.*Containment is unavailable\./);
    await app.waitFor(/Containment is unavailable\. \(unchanged since 00:00\)/);
    expect(env.requests("setup.check")).toHaveLength(0);
    env.setSetup({ permissions: { state: "done" } });
    env.passSetup(["permissions"]);
    await app.waitUntil(() => !app.frame().includes("need attention (Permissions)"), "the header to clear");
    await app.press(KEY.esc);
    await app.waitFor("Nothing said yet.");
    await command(app, "/setup");
    for (let row = 0; row < 9; row++) await app.press(KEY.down);
    await app.waitFor(/Permissions.*done/);
    expect(env.requests("setup.check")).toHaveLength(0);
  });

  it("runs Check again with Enter on the selected step", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"], setup: {
      account: { state: "needs-attention", reason: "Account needs a check.", actions: ["check-again"] },
    } })]);
    await command(app, "/setup");
    await app.waitFor("Check again");
    env.setSetup({ account: { state: "done", actions: [] } });
    await app.press(KEY.enter);
    await app.waitFor(/Account.*done/);
    expect(env.requests("setup.check").map((r) => r.params)).toEqual([{ step: "account" }]);
  });

  it("pulls both sources named by the line, even after a refusal", async () => {
    const ids = ["0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5b-d9cb-469f-a165-70867728950f"];
    const { app, env } = await launch([desk({ capabilities: ["setup"], setup: {
      ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
      skills: { state: "needs-attention", reason: "Two sources need a pull.", actions: ["pull-now"],
        targets: ids.map((id, i) => ({ action: "pull-now", kind: "skill-source", id, label: i === 0 ? "team-skills" : "house-skills" })),
      },
    } })]);
    env.wire.answer("skills.sources.pull", (params) => {
      if (params.sourceId === ids[0]) return { error: { code: "not_found", message: "The source was removed.", data: { kind: "source" } } };
      const since = app.clock.now().toISOString();
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { source: {
        id: params.sourceId, url: "https://git.example.test/team/skills", identity: "https://git.example.test/team/skills", folder: ".",
        follow: { kind: "branch", branch: "main" }, position: 1, addedBy: { kind: "client_session", id: "desk" }, addedAt: since,
        commit: "c".repeat(40), skillCount: 1, sync: { outcome: "ok", since }, attemptedAt: since,
      } } } };
    });
    await command(app, "/setup");
    await app.waitFor("Pull now: team-skills, house-skills");
    await app.press(KEY.enter);
    await app.waitFor("team-skills: Not pulled: The source was removed. house-skills: Source pulled.");
    expect(env.requests("skills.sources.pull").map((r) => r.params?.sourceId)).toEqual(ids);
  });

  it("updates a named tool in the terminal pane on the checklist's environment", async () => {
    const { app } = await launch([desk(), { name: "laptop", reach: "paired", capabilities: ["setup", "managedTools"],
      keyManagers: { tools: [{ tool: "gh" }] }, managedTools: { runs: { gh: { password: "password-for-tests", command: "sudo brew upgrade gh" } } },
      setup: { ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
        forges: { state: "needs-attention", reason: "gh needs attention.", actions: ["update"], targets: [{ action: "update", kind: "tool", id: "gh", label: "gh" }] },
      },
    }], false);
    const laptop = app.environment("laptop");
    await command(app, "/setup laptop");
    await app.waitFor("Update gh in a tool terminal");
    await app.press(KEY.enter);
    await app.waitFor("[sudo] password for milo:");
    expect(laptop.requests("tools.run").map((r) => r.params)).toEqual([{ commandId: expect.any(String), id: expect.any(String), tool: "gh", action: "update" }]);
    await app.type("password-for-tests");
    await app.press(KEY.enter);
    await app.waitFor("exit 0");
    expect(laptop.requests("terminals.write").length).toBeGreaterThan(0);
    expect(app.environment("desk").requests("tools.run")).toEqual([]);
  });

  it("waits for managed tools before offering a tool update", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup", "managedTools"],
      keyManagers: { tools: [{ tool: "gh" }] },
      setup: { ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
        forges: { state: "needs-attention", reason: "gh needs attention.", actions: ["update"], targets: [{ action: "update", kind: "tool", id: "gh", label: "gh" }] },
      },
    })]);
    let answer = () => {};
    env.wire.answer("tools.list", () => new Promise((resolve) => {
      answer = () => resolve({ result: { tools: [...env.toolRows()], probedAt: "2026-09-25T09:00:00.000Z" } });
    }));
    await command(app, "/setup");
    await app.waitFor("Reading managed tools…");
    expect(app.frame()).not.toContain("is unavailable here:");
    expect(app.frame()).not.toContain("No action offered.");
    expect(app.frame()).toContain("Waiting for managed tools before offering Update.");
    await app.press(KEY.enter);
    expect(env.requests("tools.run")).toEqual([]);
    answer();
    await app.waitFor("Action: Update gh in a tool terminal");
    expect(app.frame()).not.toContain("Reading managed tools…");
    await app.press(KEY.enter);
    await app.waitUntil(() => env.requests("tools.run").length === 1, "the update to start after the list answers");
  });

  it("restores the denylist sections named by the line then checks Permissions", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"], setup: {
      ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
      permissions: { state: "needs-attention", reason: "Denylist presets are missing.", actions: ["restore"],
        targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "paths" }, { action: "restore", kind: "denylist-section", id: "hosts", label: "hosts" }],
      },
    } })]);
    await command(app, "/setup");
    await app.waitFor("Restore: paths, hosts");
    await app.press(KEY.enter);
    await app.waitUntil(() => env.requests("setup.check").length === 1, "the restored step checked");
    expect(env.requests("permissions.denylist.restorePresets").map((r) => r.params)).toEqual([expect.objectContaining({ sections: ["paths", "hosts"] })]);
    expect(env.requests("setup.check").map((r) => r.params)).toEqual([{ step: "permissions" }]);
  });

  it("updates Your machines and points card actions at the desktop", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"], setup: {
      ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
      "your-machines": { state: "needs-attention", reason: "An update is available.", actions: ["update", "set-up-this-machine"] },
    } })]);
    env.wire.answer("updates.apply", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: false } } }));
    await command(app, "/setup");
    await app.waitFor("Action: Update now");
    await app.press(KEY.space);
    await app.waitFor("Action: Set up this machine");
    await app.press(KEY.enter);
    await app.waitFor("Set up this machine runs in the desktop window.");
    expect(env.requests("updates.apply")).toEqual([]);
    await app.press(KEY.space, KEY.enter);
    await app.waitFor("Updating desk once it is idle.");
    expect(env.requests("updates.apply").map((r) => r.params)).toEqual([expect.objectContaining({ when: "idle" })]);
  });

  it("starts this machine's service from the Your machines line", async () => {
    const { app, env } = await launch([desk({ capabilities: ["setup"], setup: {
      ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
      "your-machines": { state: "done", reason: "The service was running." },
    } })], false);
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("service down");
    await command(app, "/setup");
    await app.waitFor("Action: Start service");
    await app.press(KEY.enter);
    await app.waitUntil(() => app.service.calls.includes("start"), "the local service started");
    expect(app.service.calls).toEqual(["start"]);
  });

  it.each([false, true])("omits a tool update when it cannot run here (registry present: %s)", async (registered) => {
    const { app, env } = await launch([desk({ capabilities: registered ? ["setup", "managedTools"] : ["setup"],
      keyManagers: { tools: [{ tool: "gh", action: "copy", method: "manual", command: "upgrade-gh-by-hand" }] },
      setup: { ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
        forges: { state: "needs-attention", reason: "gh needs attention.", actions: ["update"], targets: [{ action: "update", kind: "tool", id: "gh", label: "gh" }] },
      },
    })]);
    await command(app, "/setup");
    await app.waitFor("Update gh is unavailable here:");
    expect(app.frame()).not.toContain("Action: Update gh");
    await app.press(KEY.enter);
    expect(env.requests("tools.run")).toEqual([]);
  });

  it("keeps unreachable results cached and stale without checking them", async () => {
    const { app } = await launch([desk(), { name: "laptop", reach: "paired", capabilities: ["setup"], setup: {
      ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])), account: { state: "done", reason: "Account ready." },
    } }]);
    const env = app.environment("laptop");
    await command(app, "/setup laptop");
    await app.waitFor(/Account.*done/);
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("laptop is unreachable since");
    await app.waitFor(/Account.*done.*stale/);
    expect(env.requests("setup.check")).toEqual([]);
  });

  it("keeps the Set up card and explains a refused check", async () => {
    const { app, env } = await launch(undefined, false);
    env.wire.answer("setup.check", () => ({ error: { code: "forbidden", message: "This grant cannot read setup.", data: { scope: "read" } } }));
    await command(app, "/setup");
    await app.waitFor("Set up on desk");
    await app.waitFor("Set up could not be checked: This grant cannot read setup.");
    expect(app.frame()).not.toContain("Checking Set up…");
    expect(env.requests("setup.check")).toHaveLength(1);
  });

  it("keeps a reopened card checking when an earlier card's check answers", async () => {
    const { app, env } = await launch(undefined, false);
    const answers: (() => void)[] = [];
    env.wire.answer("setup.check", () => new Promise((resolve) => answers.push(() => resolve({ result: { results: [] } }))));
    await command(app, "/setup");
    await app.waitFor("Checking Set up…");
    await app.press(KEY.esc);
    await command(app, "/setup");
    await app.waitFor("Checking Set up…");
    expect(answers).toHaveLength(2);
    answers[0]?.();
    await app.tick();
    expect(app.frame()).toContain("Checking Set up…");
    answers[1]?.();
    await app.waitUntil(() => !app.frame().includes("Checking Set up…"), "the reopened check to answer");
    expect(app.frame()).toContain("Set up on desk");
  });

  it("checks the named environment without a setup stream, and says when none is known by that name", async () => {
    const { app } = await launch([desk(), { name: "laptop", reach: "paired" }], false);
    await command(app, "/setup laptop");
    await app.waitFor("Set up on laptop");
    await app.waitFor(/Account.*done/);
    await app.waitFor("Live Set up updates are unavailable on this environment; /setup checks again.");
    expect(app.environment("laptop").requests("setup.check").map((r) => r.params)).toEqual([{}]);
    expect(app.environment("desk").requests("setup.check")).toEqual([]);
    await app.press(KEY.esc);
    await command(app, "/setup attic");
    await app.waitFor("No environment named attic is known here.");
  });
});
