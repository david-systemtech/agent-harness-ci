import { randomUUID } from "node:crypto";
import type { AccountRecord, SignIn } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../../test/clock.js";
import { fakeSignInSpawner, loginBanner, type FakeSignInProcess, type FakeSignInSpawner } from "../../test/signin.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { claudeSignInProgram } from "../adapters/claude/signin.js";
import { formatActor, openEventLog, type EventLog, type Tx } from "../event-log/event-log.js";
import type { CommandContext } from "../serve/methods.js";
import type { SignInDirector, SignInOutcome } from "./signin-seam.js";
import { createSignInDirector } from "./signin-director.js";

/**
 * The director below the wire (#135, review): a command's transition and a
 * process event cannot interleave. The log runs a command's `afterCommit`
 * callbacks in the commit's own synchronous turn, before any listener and
 * before any microtask, timer or I/O callback, so an exit or the expiry
 * lands before the command or after its callback, never between. The
 * callbacks are guarded all the same: one run late (a context whose
 * `afterCommit` defers, standing in for a log that ever did) never
 * overwrites a sign-in the process ended, or one completing.
 */

const ENVIRONMENT = "5b1c6f3e-0000-4000-8000-000000000001";
const DIRECTORY = "/tmp/agent-harness-test/work";
const ACTOR = formatActor({ kind: "client_session", id: "tester" });

const account: AccountRecord = {
  id: "work",
  provider: "claude",
  label: "work",
  directory: { kind: "adopted", path: DIRECTORY },
  identity: null,
  status: { state: "signed-out", checkedAt: null, detail: null },
  createdAt: "2026-09-24T00:00:00.000Z",
};

interface Setup {
  readonly log: EventLog;
  readonly clock: ManualClock;
  readonly spawner: FakeSignInSpawner;
  readonly director: SignInDirector;
  /** Settles the status read the director's `finished` is waiting on. */
  finish(outcome: SignInOutcome): void;
}

const opened: EventLog[] = [];
afterEach(() => {
  for (const log of opened.splice(0)) log.close();
});

const setup = (): Setup => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: () => clock.now() });
  opened.push(log);
  const spawner = fakeSignInSpawner();
  const reads: ((outcome: SignInOutcome) => void)[] = [];
  const director = createSignInDirector({
    log,
    clock,
    environmentId: ENVIRONMENT,
    programs: { claude: claudeSignInProgram({ bundled: "/opt/sdk/claude", hostEnv: { PATH: "/usr/bin" }, managedTool: () => null }) },
    spawn: spawner.spawn,
    cwd: "/tmp",
  })({
    account: (id) => (id === account.id ? account : null),
    finished: () => new Promise((resolve) => reads.push(resolve)),
  });
  return {
    log,
    clock,
    spawner,
    director,
    finish: (outcome) => {
      const read = reads.shift();
      if (read === undefined) throw new Error("No status read is waiting.");
      read(outcome);
    },
  };
};

/** Runs `handler` as the log runs a command: inside `command`, in its transaction. */
const asCommand = (log: EventLog, handler: (context: CommandContext) => unknown): void => {
  const commandId = randomUUID();
  log.command({ actor: ACTOR, commandId }, (tx) => handler({ clientSession: undefined as never, commandId, actor: ACTOR, tx }) as never);
};

/** A context whose `afterCommit` runs its callbacks only when the test says: a late callback. */
const lateContext = (): { context: CommandContext; runLate(): void } => {
  const callbacks: (() => void)[] = [];
  const tx: Tx = { afterCommit: (callback) => void callbacks.push(callback) };
  return {
    context: { clientSession: undefined as never, commandId: randomUUID(), actor: ACTOR, tx },
    runLate: () => {
      for (const callback of callbacks.splice(0)) callback();
    },
  };
};

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const notices = (log: EventLog): SignIn["state"][] =>
  log
    .readStream({ kind: "environment", id: ENVIRONMENT })
    .filter((event) => event.type === "signin.updated")
    .map((event) => (event.payload as unknown as SignIn).state);

/** Starts `work`'s sign-in and resolves once it is awaiting a code. */
const awaitingCode = async (s: Setup): Promise<FakeSignInProcess> => {
  asCommand(s.log, (context) => s.director.begin({ accountId: "work" }, context));
  const login = await s.spawner.nextLogin();
  login.print(loginBanner());
  await until(() => s.director.latest()?.state === "awaiting-code", "awaiting-code");
  return login;
};

describe("a command's transition and a process event", () => {
  it("never interleave: the callback runs in the commit's own turn, before a queued exit, a listener or a timer", async () => {
    const s = setup();
    const login = await awaitingCode(s);
    const order: string[] = [];
    s.log.subscribe(() => order.push("listener"));
    asCommand(s.log, (context) => {
      // An exit queued inside the command's transaction: it can land only after the commit's turn.
      queueMicrotask(() => {
        order.push("exit");
        login.exit(1);
      });
      setImmediate(() => order.push("macrotask"));
      context.tx.afterCommit(() => order.push("callback"));
      return s.director.code({ accountId: "work", code: "abc" }, context);
    });
    // Still in the commit's turn: the code went in, and nothing queued has run.
    expect(s.director.latest()?.state).toBe("submitting");
    expect(login.written).toEqual(["abc\n"]);
    expect(order).toEqual(["callback", "listener"]);
    await until(() => s.director.latest()?.state === "failed", "failed");
    expect(order.slice(0, 3)).toEqual(["callback", "listener", "exit"]);
    expect(notices(s.log)).toEqual(["starting", "awaiting-code", "submitting", "failed"]);
  });
});

describe("a command's callback run late", () => {
  it("leaves a sign-in the CLI ended failed, re-arms nothing, and frees the floor", async () => {
    const s = setup();
    const login = await awaitingCode(s);
    const late = lateContext();
    s.director.code({ accountId: "work", code: "abc" }, late.context);
    login.printError("OAuth error\n");
    login.exit(1);
    await until(() => s.director.latest()?.state === "failed", "failed");
    const timers = s.clock.pending();
    late.runLate();
    expect(s.director.latest()?.state).toBe("failed");
    expect(login.written).toEqual([]);
    expect(s.clock.pending()).toBe(timers);
    // Nothing holds the floor behind the dead process.
    expect(s.director.ready(account)).toEqual({ started: true, message: null });
  });

  it("leaves a completing sign-in to its status read, which ends it done", async () => {
    const s = setup();
    const login = await awaitingCode(s);
    const late = lateContext();
    s.director.code({ accountId: "work", code: "abc" }, late.context);
    login.exit(0);
    await until(() => notices(s.log).length === 2 && s.clock.pending() === 0, "the expiry cancelled for completing");
    late.runLate();
    expect(login.written).toEqual([]);
    expect(s.clock.pending()).toBe(0);
    s.finish({ signedIn: true, account });
    await until(() => s.director.latest()?.state === "done", "done");
    expect(s.director.ready(account)).toEqual({ started: true, message: null });
  });

  it("does not cancel over a sign-in the CLI ended, nor over one completing", async () => {
    const s = setup();
    const first = await awaitingCode(s);
    const late = lateContext();
    s.director.cancel({ accountId: "work" }, late.context);
    first.exit(1);
    await until(() => s.director.latest()?.state === "failed", "failed");
    late.runLate();
    expect(s.director.latest()?.state).toBe("failed");

    const second = await awaitingCode(s);
    const later = lateContext();
    s.director.cancel({ accountId: "work" }, later.context);
    second.exit(0);
    await until(() => s.clock.pending() === 0, "completing");
    later.runLate();
    expect(second.killed).toBe(false);
    s.finish({ signedIn: true, account });
    await until(() => s.director.latest()?.state === "done", "done");
  });
});
