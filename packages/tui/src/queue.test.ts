import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Read now and withdraw in the terminal UI (docs/specs/tui.md, "The
 * composer"; ADR 0022; #231): the queued line drawn from `projections.runs`,
 * `Ctrl+Enter` (`composer.readNow`) dispatching `runs.readNow`, and `↑` on an
 * empty composer (`composer.withdrawLast`, conditioned, beside
 * `composer.navigate` on the same key) dispatching `runs.withdraw` for the
 * newest queued message, whose text comes back through the session's draft.
 * A verb the runtime says cannot be used now refuses at once with one line,
 * and the queued line draws it dim with its reason, never hidden; a refusal
 * the environment answers is one line with its reason.
 */

let apps: RenderedApp[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
/** Ctrl+Enter as a terminal speaking the kitty keyboard protocol sends it. */
const CTRL_ENTER = "\u001B[13;5u";
/** Alt+W: Esc, then the letter. */
const ALT_W = "\u001Bw";
/** A queued message's id as the environment's refusals name it. */
const SOME_MESSAGE = "0199a200-0000-4000-8000-000000000003";

const launch = async (environment: Partial<ScriptedEnvironment> = {}, extra: Partial<Parameters<typeof renderApp>[0]> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts", workspace: { kind: "directory", path: "/home/seth/receipts" } }], ...environment }] },
    flags: { session: SESSION },
    ...extra,
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const send = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

/** A run live with `queued` sent during it, each waiting on the queued line. */
const withQueue = async (app: RenderedApp, ...queued: string[]) => {
  await send(app, "Fix the receipts");
  await app.waitFor("steer or queue a message");
  for (const text of queued) {
    await send(app, text);
    await app.waitFor(new RegExp(`(⧗ queued|↳ steering) ${text}`));
  }
};

const rowIndex = (app: RenderedApp, text: string) => app.rows().findIndex((row) => row.includes(text));
/** What the screen right of the rail says, its rows joined as a wrapped line reads. */
const mainText = (app: RenderedApp) =>
  app
    .rows()
    .map((row) => (row.includes("│") ? row.slice(row.indexOf("│") + 1) : row))
    .join(" ")
    .replace(/\s+/g, " ");

describe("the queued line", () => {
  it("draws the session's queue from projections.runs in order: text, attachment chips, and who holds it where it matters", async () => {
    const { app, env } = await launch({ queue: "provider", provider: { providerQueue: true, steering: true } });
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    const runId = env.liveRun(SESSION) ?? "";
    env.emit(SESSION, "message.sent", {
      runId,
      messageId: "0199a200-0000-4000-8000-00000000aaaa",
      text: "look at this",
      attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", size: 2048 }],
      delivery: "queued",
      heldBy: "environment",
      ceiling: "bypassPermissions",
    });
    await send(app, "use the other parser");
    await app.waitFor("↳ steering use the other parser");
    // The environment's message waits for the next run; the provider's is being steered into this one.
    expect(app.frame()).toContain("⧗ queued look at this [shot.png]");
    expect(rowIndex(app, "look at this")).toBeLessThan(rowIndex(app, "use the other parser"));
    expect(app.frame()).toContain("Ctrl+Enter read now · ↑ (empty composer) take the newest back");
  });

  it("lets a steered or delivered message leave the line for the transcript, and keeps a re-owned one in its place", async () => {
    const { app, env } = await launch({ queue: "provider", provider: { providerQueue: true, steering: true } });
    await withQueue(app, "first thought", "second thought", "third thought");
    const [first, second] = env.queued(SESSION);
    // Interrupt re-owns what the provider held: the environment holds it now, in its original place.
    env.emit(SESSION, "message.requeued", { runId: first?.runId ?? "", messageId: first?.messageId ?? "" });
    await app.waitFor("⧗ queued first thought");
    expect(rowIndex(app, "first thought")).toBeLessThan(rowIndex(app, "second thought"));
    expect(app.frame()).toContain("↳ steering second thought");
    env.emit(SESSION, "message.delivered", { runId: second?.runId ?? "", messageId: second?.messageId ?? "", delivery: "steered" });
    await app.waitUntil(() => !app.frame().includes("steering second thought"), "the steered message to leave the queued line");
    // Steered, it is a row of the transcript where it was sent.
    expect(app.frame()).toContain("▌ second thought");
    expect(app.frame()).toContain("⧗ queued first thought");
    expect(app.frame()).toContain("↳ steering third thought");
  });

  it("draws nothing when nothing is queued", async () => {
    const { app } = await launch();
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    expect(app.frame()).not.toContain("Ctrl+Enter read now");
  });
});

describe("Ctrl+Enter reads the queue now", () => {
  it("dispatches runs.readNow for the session, and the next run's transcript opens with the queued messages as its prompt", async () => {
    const { app, env } = await launch();
    await withQueue(app, "and the tests", "and the docs");
    const runId = env.liveRun(SESSION) ?? "";
    env.emit(SESSION, "assistant.text", { runId, itemId: "i-1", text: "Reading the receipts module.", aborted: false });
    await app.waitFor("Reading the receipts module.");
    await app.press(CTRL_ENTER);
    await app.waitFor("Interrupted to read the queue");
    expect(env.requests("runs.readNow").map((request) => request.params)).toEqual([expect.objectContaining({ sessionId: SESSION })]);
    await app.waitUntil(() => !app.frame().includes("⧗ queued"), "the queue to leave the queued line");
    // The interrupted turn first, then the next run opening with the queue, in the order it was sent.
    const interrupted = rowIndex(app, "Interrupted to read the queue");
    expect(rowIndex(app, "Reading the receipts module.")).toBeLessThan(interrupted);
    expect(rowIndex(app, "▌ and the tests")).toBeGreaterThan(interrupted);
    expect(rowIndex(app, "▌ and the docs")).toBeGreaterThan(rowIndex(app, "▌ and the tests"));
    expect(env.liveRun(SESSION)).not.toBe(runId);
  });
});

describe("↑ on an empty composer withdraws the newest queued message", () => {
  it("dispatches runs.withdraw for the newest, and its text comes into the composer through the session's draft", async () => {
    const { app, env } = await launch();
    await withQueue(app, "and the tests", "and the docs");
    const newest = env.queued(SESSION).at(-1);
    await app.press(KEY.up);
    await app.waitFor("› and the docs");
    expect(env.requests("runs.withdraw").map((request) => request.params)).toEqual([expect.objectContaining({ messageId: newest?.messageId })]);
    expect(env.summary(SESSION).draft).toBe("and the docs");
    expect(app.frame()).toContain("⧗ queued and the tests");
    expect(app.frame()).not.toContain("⧗ queued and the docs");
    // Withdrawn, it is neither queued nor a message on its way.
    expect(app.frame()).not.toContain("and the docs · sending");
    // With text in the composer, ↑ is the composer's own again: nothing more is withdrawn.
    await app.press(KEY.up);
    expect(env.requests("runs.withdraw")).toHaveLength(1);
    expect(app.frame()).toContain("⧗ queued and the tests");
  });

  it("withdraws nothing while a card takes a line: ↑ at the label of an account being added is the card's (#147)", async () => {
    const { app, env } = await launch({ accounts: [{ id: "account-1", label: "work" }] });
    await withQueue(app, "and the docs");
    await send(app, "/account");
    await app.waitFor("+ Add an account");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Label for the new account:");
    await app.press(KEY.up);
    await app.type("side");
    await app.waitFor("Label for the new account: side");
    expect(env.requests("runs.withdraw")).toEqual([]);
    expect(env.queued(SESSION).map((m) => m.text)).toEqual(["and the docs"]);
  });

  it("walks the history as before when nothing is queued", async () => {
    const { app, env } = await launch();
    await send(app, "Fix the receipts");
    await app.waitFor("steer or queue a message");
    await app.press(KEY.up);
    await app.waitFor("› Fix the receipts");
    expect(env.requests("runs.withdraw")).toEqual([]);
  });

  it("says in one line that the provider read it first (not_found), and leaves the message wherever the log says it is", async () => {
    const { app, env } = await launch({
      receipts: {
        "runs.withdraw": {
          rejected: "not_found",
          message: `No queued message ${SOME_MESSAGE} is on this environment: the provider has read it.`,
          data: { kind: "message", messageId: SOME_MESSAGE },
        },
      },
    });
    await withQueue(app, "and the tests");
    await app.press(KEY.up);
    await app.waitFor("Not withdrawn: the provider read it first.");
    // Nothing moved on this client's say-so: the message is on the queued line until the log says a run read it.
    expect(app.frame()).toContain("⧗ queued and the tests");
    expect(app.frame()).not.toContain("› and the tests");
    const [message] = env.queued(SESSION);
    env.emit(SESSION, "message.delivered", { runId: message?.runId ?? "", messageId: message?.messageId ?? "", delivery: "steered" });
    await app.waitFor("▌ and the tests");
    expect(app.frame()).not.toContain("⧗ queued and the tests");
  });

  it("passes the environment's own word through for any other not_found: taken back already, by another client", async () => {
    const already = `No queued message ${SOME_MESSAGE} is on this environment: it was withdrawn already.`;
    const { app } = await launch({ receipts: { "runs.withdraw": { rejected: "not_found", message: already, data: { kind: "message", messageId: SOME_MESSAGE } } } });
    await withQueue(app, "and the tests");
    await app.press(KEY.up);
    await app.waitFor(`Not withdrawn: ${already}`);
    expect(app.frame()).not.toContain("the provider read it first");
  });

  it("sends one withdraw while one is on its way for the newest message, however often ↑ is pressed", async () => {
    const { app, env } = await launch();
    await withQueue(app, "and the tests", "and the docs");
    const newest = env.queued(SESSION).at(-1);
    const answers: ((answer: FakeAnswer) => void)[] = [];
    env.wire.answer("runs.withdraw", () => new Promise<FakeAnswer>((resolve) => answers.push(resolve)));
    await app.press(KEY.up);
    await app.waitUntil(() => answers.length === 1, "the withdraw to reach the environment");
    // Pressed again before anything came back: the composer is still empty and the message still queued.
    await app.press(KEY.up);
    // The environment takes it back as it does: the message leaves the queue and its text is the draft, then the receipt.
    env.emit(SESSION, "message.withdrawn", { runId: newest?.runId ?? "", messageId: newest?.messageId ?? "", heldBy: "environment" });
    const draft = env.emit(SESSION, "session.draft-set", { draft: "and the docs" }, { fields: { draft: "and the docs" } });
    answers[0]?.({ result: { receipt: { status: "accepted", sequence: draft.sequence, changed: true }, result: { messageId: newest?.messageId, sessionId: SESSION, heldBy: "environment" } } });
    await app.waitFor("› and the docs");
    await app.tick(5);
    expect(env.requests("runs.withdraw")).toHaveLength(1);
    expect(app.frame()).not.toContain("Not withdrawn");
    expect(app.frame()).toContain("⧗ queued and the tests");
  });

  it("sends this terminal's waiting draft before the withdraw, so the text coming back is the draft that stays", async () => {
    const { app, env } = await launch();
    await withQueue(app, "and the tests");
    const sentBefore = env.requests().length;
    await app.type("half a thought");
    // Cleared: the empty draft waits its second, which the manual clock never passes on its own.
    await app.press(KEY.ctrlU);
    await app.waitUntil(() => !app.frame().includes("› half a thought"), "the composer to empty");
    await app.press(KEY.up);
    await app.waitFor("› and the tests");
    await app.jump(1500);
    const sent = env.requests().slice(sentBefore).map((request) => request.method);
    expect(sent.filter((method) => method === "sessions.setDraft" || method === "runs.withdraw")).toEqual(["sessions.setDraft", "runs.withdraw"]);
    expect(env.summary(SESSION).draft).toBe("and the tests");
    expect(app.frame()).toContain("› and the tests");
  });

  it("leaves ↑ to the history when every queued message is one the provider is opening a turn with", async () => {
    const { app, env } = await launch({ queue: "provider", provider: { providerQueue: true } });
    await withQueue(app, "and the tests");
    // The turn ends with the message still the provider's: a turn it opens reads it, and no withdraw reaches it.
    env.endRun(SESSION, env.liveRun(SESSION) ?? "");
    await app.waitUntil(() => mainText(app).includes("take the newest back (Nothing is queued to withdraw.)"), "withdraw to have nothing to reach");
    await app.press(KEY.up);
    // The history's newest entry, not a refusal.
    await app.waitFor("› and the tests");
    expect(env.requests("runs.withdraw")).toEqual([]);
    expect(app.frame()).not.toContain("Not withdrawn");
  });
});

describe("when a verb cannot be used", () => {
  it("refuses both keys at once with one line while the environment is unreachable, dispatching nothing, and draws them dim with the reason", async () => {
    const { app, env } = await launch();
    await withQueue(app, "and the tests");
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("Locked: desk cannot be reached.");
    await app.press(KEY.up);
    await app.waitFor("Not withdrawn: desk cannot be reached.");
    await app.press(CTRL_ENTER);
    await app.waitFor("Not read now: desk cannot be reached.");
    expect(env.requests("runs.withdraw")).toEqual([]);
    expect(env.requests("runs.readNow")).toEqual([]);
    expect(mainText(app)).toContain("Ctrl+Enter read now (desk cannot be reached.)");
    expect(mainText(app)).toContain("↑ (empty composer) take the newest back (desk cannot be reached.)");
  });

  it("refuses in one line with the adapter's reason as the environment gives it, and asks the environment again at the next ↑", async () => {
    // Nothing on the wire says an adapter cannot withdraw, and the environment refuses only a message the provider holds:
    // one refusal is not kept, so a message an interrupt hands back to the environment can still be taken back.
    const reason = "The Claude adapter cannot withdraw a queued message: its CLI has no cancel-by-id control.";
    const { app, env } = await launch({
      receipts: { "runs.withdraw": { rejected: "invalid_params", message: reason, data: { reason: "unsupported", capability: "providerQueue", provider: "claude" } } },
    });
    await withQueue(app, "and the tests");
    await app.press(KEY.up);
    await app.waitFor(`Not withdrawn: ${reason}`);
    expect(mainText(app)).toContain("Ctrl+Enter read now · ↑ (empty composer) take the newest back");
    expect(app.frame()).toContain("⧗ queued and the tests");
    await app.press(KEY.up);
    await app.waitUntil(() => env.requests("runs.withdraw").length === 2, "the second ↑ to ask the environment again");
  });
});

describe("composer.withdrawLast in the keymap", () => {
  const keybindings = (mapping: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-queue-"));
    dirs.push(dir);
    const path = join(dir, "keybindings.json");
    writeFileSync(path, JSON.stringify(mapping));
    return { stateDir: dir, flag: path };
  };

  it("is remapped apart from composer.navigate: the new key withdraws on an empty composer, and ↑ walks the history", async () => {
    const { app, env } = await launch({}, { keybindings: keybindings({ "composer.withdrawLast": ["Alt+W"] }) });
    await withQueue(app, "and the tests");
    expect(app.frame()).toContain("Alt+W (empty composer) take the newest back");
    await app.press(KEY.up);
    await app.waitFor("› and the tests");
    expect(env.requests("runs.withdraw")).toEqual([]);
    await app.press(KEY.ctrlU);
    await app.waitUntil(() => !app.frame().includes("› and the tests"), "the composer to empty");
    await app.press(ALT_W);
    await app.waitUntil(() => env.requests("runs.withdraw").length === 1, "Alt+W to withdraw");
    await app.waitFor("› and the tests");
  });

  it("is drawn in /help with its condition, answered", async () => {
    const { app } = await launch();
    await app.press("?");
    for (let i = 0; i < 10 && !app.frame().includes("Take the newest queued message back to edit"); i++) await app.press(KEY.pageDown);
    const row = app.rows().find((line) => line.includes("Take the newest queued message back to edit")) ?? "";
    expect(row).toContain("↑ (empty composer)");
    expect(row).not.toContain("(soon)");
    expect(app.rows().find((line) => line.includes("Have the queued message read now")) ?? "").not.toContain("(soon)");
  });
});
