import { homedir } from "node:os";
import {
  ENVIRONMENT_STREAM_KIND,
  SIGN_IN_ENDED_STATES,
  SignIn as SignInSchema,
  SignInExecutableChosenPayload,
  type AccountRecord,
  type SignIn,
  type SignInExecutableSource,
  type SignInState,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { CommandContext } from "../serve/methods.js";
import type { SignInAnswer, SignInDirector, SignInDirectorFactory, SignInPort, SignInProgram } from "./signin-seam.js";
import { keep, runToExit, spawnSignInProcess, type SignInChild, type SignInSpawn } from "./signin-process.js";

/**
 * The sign-in director (claude-adapter spec, "Sign-in and status through the
 * bundled binary"; ADR 0018): one sign-in per environment, driven through
 * the provider's own CLI, which alone ever sees the credential.
 *
 * - **Start** (`accounts.signin.start`, or `accounts.add` once it has
 *   committed): `starting`; the executable is chosen, then spawned with the
 *   program's argv (`auth login`), the account's directory in its
 *   environment and the scrubbed variables absent, stdin a pipe and stdout
 *   read as it comes. A second start while one runs is refused, naming the
 *   account that holds the sign-in.
 * - **The URL**: once stdout holds a whole verification URL, `awaiting-code`
 *   with the URL, published as a `signin.updated` notice.
 * - **The code** (`accounts.signin.code`), from any client: written to
 *   stdin, `submitting`.
 * - **The end**: exit 0 is the port's `finished`, the account store's status
 *   read (which appends `account.identity-set`, or refuses an identity
 *   another account holds): `done` when it reads signed in, else `failed`
 *   with what it said; any other exit is `failed` with stderr's last line,
 *   its cause `code-refused` when the code had been written (the provider
 *   refused it).
 *   While that read runs the sign-in is completing: the expiry is off and a
 *   cancel or a removal is refused, so it cannot end otherwise after the
 *   identity was recorded. Ten minutes on the environment's clock with no
 *   code, or after the code, is `expired`; `accounts.signin.cancel` is
 *   `cancelled`; either stops the process. Removing the account cancels its
 *   sign-in with the cause `account-removed`.
 * - **A restart** ends a sign-in the last run left running: its latest
 *   notice is followed by a `cancelled` one ("The environment restarted.",
 *   the cause `restarted`).
 * - **Every change of state** is a `signin.updated` notice on the
 *   environment's stream, carrying the sign-in: a command's in its own
 *   transaction, with its receipt, and the process's as `system:sign-in`.
 * - **The executable**, chosen once per environment and bundled binary: the
 *   bundled one when its probe says it runs a sign-in, else the managed tool
 *   when its probe does; recorded as a `signin.executable-chosen` notice,
 *   which later starts read back instead of probing. A choice that finds
 *   neither is not recorded, so the next sign-in looks again.
 */

/** How long a sign-in waits for a code, and for the CLI to finish after one (ADR 0018). */
export const SIGN_IN_EXPIRY_MS = 10 * 60_000;

/** How long a probe of an executable may take, on the wall clock. */
export const EXECUTABLE_PROBE_TIMEOUT_MS = 15_000;

/** The director's own actor: the changes the process makes, and the executable's choice. */
export const SIGN_IN_ACTOR = formatActor({ kind: "system", id: "sign-in" });

export interface SignInDirectorOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's id: its stream, where the notices go. */
  readonly environmentId: string;
  /** The sign-in program of each provider that can sign in from the environment, by provider id. */
  readonly programs: Readonly<Record<string, SignInProgram>>;
  /** Starts a process; preset: `node:child_process`. */
  readonly spawn?: SignInSpawn;
  /** Where the process runs; preset: the home directory. */
  readonly cwd?: string;
  /** Preset `EXECUTABLE_PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
}

/** A sign-in as the director holds it: the state it published, and the process behind it. */
interface Running {
  readonly accountId: string;
  readonly label: string;
  readonly provider: string;
  readonly directory: string;
  readonly program: SignInProgram;
  state: SignIn;
  child: SignInChild | null;
  timer: Timer | null;
  /** Set once the CLI exited 0 and the status read is under way: nothing but its outcome ends the sign-in then. */
  completing: boolean;
  /** The outcome a completing sign-in reached whose notice the log refused: its re-armed expiry records it (#223). */
  unrecorded: Partial<SignIn> | null;
  stdout: string;
  stderr: string;
}

/** Which executable a provider's sign-ins run, once chosen. */
interface Choice {
  readonly source: SignInExecutableSource;
  readonly executable: string;
}

const ENDED: readonly SignInState[] = SIGN_IN_ENDED_STATES;

const ended = (state: SignIn): boolean => ENDED.includes(state.state);

/** The last line of `output` that says something; null when none does. */
const lastLine = (output: string): string | null =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? null;

/** The first line of `output` that says something (a probe's usage line); null when none does. */
const firstLine = (output: string): string | null =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "") ?? null;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createSignInDirector =
  (options: SignInDirectorOptions): SignInDirectorFactory =>
  (port: SignInPort): SignInDirector => {
    const { log, clock, environmentId, programs } = options;
    const spawnWith = options.spawn ?? spawnSignInProcess;
    const cwd = options.cwd ?? homedir();
    const probeTimeoutMs = options.probeTimeoutMs ?? EXECUTABLE_PROBE_TIMEOUT_MS;
    const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: environmentId };
    /** The latest sign-in since the environment started, running or ended. */
    let current: Running | null = null;
    /** The executable each provider's sign-ins run, once chosen (or read back); in flight while it is being chosen. */
    const choices = new Map<string, Promise<Choice>>();
    let closed = false;
    /** Aborted when the environment closes: a probe in flight is killed. */
    const closing = new AbortController();

    const running = (): Running | null => (current !== null && !ended(current.state) ? current : null);

    const programOf = (provider: string): SignInProgram | undefined => (Object.hasOwn(programs, provider) ? programs[provider] : undefined);

    const unavailableMessage = (account: Pick<AccountRecord, "provider" | "directory">): string =>
      `Signing in from the environment is not available for the ${account.provider} provider. The account's directory is ${account.directory.path}; sign it in with the provider's own CLI there, then check the account again.`;

    const heldMessage = (holder: Running): string => `A sign-in is already running for ${holder.label}; cancel it, or wait for it to end.`;

    /** The choice recorded for `provider` against its bundled binary, if one was; the latest wins. */
    const recorded = (provider: string, program: SignInProgram): Choice | null => {
      const rows = log.read<{ payload: string }>(
        "SELECT payload FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'signin.executable-chosen' ORDER BY sequence DESC",
        ENVIRONMENT_STREAM_KIND,
        environmentId,
      );
      for (const row of rows) {
        const parsed = SignInExecutableChosenPayload.safeParse(JSON.parse(row.payload));
        if (!parsed.success || parsed.data.provider !== provider) continue;
        // Made against another bundled binary (the harness was updated): chosen again.
        if (parsed.data.bundled !== program.bundled) return null;
        return { source: parsed.data.source, executable: parsed.data.executable };
      }
      return null;
    };

    /** The executable a fallback names before the choice: the one chosen, else the bundled one, else the managed tool's name. */
    const likelyExecutable = (provider: string, program: SignInProgram): string => {
      const known = recorded(provider, program);
      return known?.executable ?? program.bundled ?? program.toolName;
    };

    const noticeOf = (state: SignIn) => ({ type: "signin.updated", payload: state });

    /**
     * Publishes the process's change of state as `system:sign-in`; a sign-in
     * that has ended, or been replaced, changes no more. The state held
     * changes only once its notice is in the log, so the two never differ;
     * an end whose notice could not be appended still stops the process,
     * whose exit then tries to notice the sign-in's failure. A completing
     * sign-in has no process left to exit: `complete` releases it instead.
     */
    const update = (sign: Running, change: Partial<SignIn>): void => {
      if (closed || current !== sign || ended(sign.state)) return;
      const next: SignIn = { ...sign.state, ...change };
      try {
        log.append(stream, [noticeOf(next)], { actor: SIGN_IN_ACTOR });
      } catch (error) {
        console.error(`Noticing the sign-in of ${sign.label} failed; its state is left as it was:`, error);
        if (ended(next)) sign.child?.kill();
        return;
      }
      sign.state = next;
      if (ended(next)) stop(sign);
    };

    /** Stops what a sign-in that has ended still holds: its expiry and its process. */
    const stop = (sign: Running): void => {
      sign.timer?.cancel();
      sign.timer = null;
      sign.child?.kill();
    };

    const arm = (sign: Running): void => {
      sign.timer?.cancel();
      const due = Math.max(0, new Date(sign.state.expiresAt).getTime() - clock.now().getTime());
      sign.timer = clock.setTimeout(() => {
        sign.timer = null;
        const error =
          sign.state.state === "submitting"
            ? "The provider's CLI did not finish within ten minutes of the code."
            : "No code came within ten minutes; start the sign-in again.";
        update(sign, sign.unrecorded ?? { state: "expired", error });
      }, due);
    };

    /** Probes one executable; answers why it does not run a sign-in, or null when it does. */
    const refuses = async (program: SignInProgram, executable: string, directory: string): Promise<string | null> => {
      const result = await runToExit(spawnWith, executable, program.probeArgv, { env: program.env(directory), cwd }, probeTimeoutMs, closing.signal);
      if (program.runsSignIn(result)) return null;
      const said = lastLine(result.stderr) ?? firstLine(result.stdout);
      const how = result.code === null ? "could not be run" : `answered ${program.probeArgv.join(" ")} with exit code ${result.code}`;
      return `${executable} ${how} without a sign-in command${said === null ? "" : ` (${said})`}.`;
    };

    /** The managed tool where the PATH has it now. */
    const managedOnPath = async (program: SignInProgram): Promise<string> => {
      const found = await program.managedTool();
      if (found === null) throw new Error(`The managed tool ${program.toolName} chosen for sign-in is no longer on the PATH; run the fallback command in a terminal.`);
      return found;
    };

    /** Chooses the executable, probing the bundled binary and then the managed tool, and records the choice. */
    const choose = async (provider: string, program: SignInProgram, directory: string): Promise<Choice> => {
      const known = recorded(provider, program);
      if (known !== null) {
        if (known.source === "bundled") return known;
        // The managed tool is found on the PATH each time, as its registry detects it; the recorded path names where it was.
        return { source: "managed-tool", executable: await managedOnPath(program) };
      }
      let detail: string;
      if (program.bundled === null) detail = "This platform has no bundled binary.";
      else {
        const refused = await refuses(program, program.bundled, directory);
        if (refused === null) return record(provider, program, { source: "bundled", executable: program.bundled }, null);
        detail = refused;
      }
      const managed = await program.managedTool();
      if (managed === null) throw new Error(`${detail} The managed tool ${program.toolName} is not on the PATH. Run the fallback command in a terminal on this machine.`);
      const refused = await refuses(program, managed, directory);
      if (refused !== null) throw new Error(`${detail} ${refused} Run the fallback command in a terminal on this machine.`);
      return record(provider, program, { source: "managed-tool", executable: managed }, detail);
    };

    const record = (provider: string, program: SignInProgram, choice: Choice, detail: string | null): Choice => {
      const payload = { provider, source: choice.source, executable: choice.executable, bundled: program.bundled, detail };
      if (!closed) log.append(stream, [{ type: "signin.executable-chosen", payload }], { actor: SIGN_IN_ACTOR });
      return choice;
    };

    /**
     * The provider's executable: chosen once, shared while it is being
     * chosen, looked for again after a choice that found none; a managed-tool
     * choice finds the tool on the PATH again for every sign-in.
     */
    const executableFor = async (sign: Running): Promise<Choice> => {
      let choosing = choices.get(sign.provider);
      if (choosing === undefined) {
        choosing = choose(sign.provider, sign.program, sign.directory);
        choices.set(sign.provider, choosing);
        choosing.catch(() => choices.delete(sign.provider));
      }
      const choice = await choosing;
      if (choice.source !== "managed-tool") return choice;
      return { source: "managed-tool", executable: await managedOnPath(sign.program) };
    };

    /** The exit: 0 is the status read through the port, anything else a failure with the CLI's last words. */
    const exited = async (sign: Running, code: number | null, error: string | null): Promise<void> => {
      sign.child = null;
      if (current !== sign || ended(sign.state)) return;
      if (code !== 0) {
        const said = lastLine(sign.stderr) ?? error ?? lastLine(sign.stdout);
        const how = code === null ? "The provider's CLI stopped" : `The provider's CLI exited with code ${code}`;
        // After the code was written, the CLI fails only as the provider refuses it.
        update(sign, { state: "failed", error: said === null ? `${how}.` : `${how}: ${said}`, ...(sign.state.state === "submitting" && { cause: "code-refused" as const }) });
        return;
      }
      // Completing: the status read decides, and neither the expiry, a cancel nor a removal cuts across the identity it records.
      sign.completing = true;
      sign.timer?.cancel();
      sign.timer = null;
      let outcome;
      try {
        outcome = await port.finished(sign.accountId);
      } catch (thrown) {
        complete(sign, { state: "failed", error: `Reading the account's status after its sign-in failed: ${messageOf(thrown)}` });
        return;
      }
      complete(sign, outcome.signedIn ? { state: "done", error: null } : { state: "failed", error: outcome.message });
    };

    /**
     * Ends a completing sign-in as its status read says. When the log refuses
     * that notice the sign-in is still running, in the log and so here, but
     * nothing is completing any more and no process is left to exit: the
     * outcome is kept, the expiry is armed again and records it when it
     * fires, and a cancel or a removal can end the sign-in before then, so
     * it never holds the one-sign-in slot until a restart (#223).
     */
    const complete = (sign: Running, outcome: Partial<SignIn>): void => {
      update(sign, outcome);
      if (closed || current !== sign || ended(sign.state)) return;
      sign.completing = false;
      sign.unrecorded = outcome;
      arm(sign);
    };

    /** Chooses the executable and starts the process: what a start sets off once it has committed. */
    const launch = async (sign: Running): Promise<void> => {
      arm(sign);
      let choice: Choice;
      try {
        choice = await executableFor(sign);
      } catch (thrown) {
        update(sign, { state: "failed", error: messageOf(thrown) });
        return;
      }
      if (current !== sign || ended(sign.state) || closed) return;
      const fallback = sign.program.fallback(sign.directory, choice.executable);
      if (fallback.posix !== sign.state.fallback.posix) update(sign, { fallback });
      let child: SignInChild;
      try {
        child = spawnWith(choice.executable, sign.program.argv, { env: sign.program.env(sign.directory), cwd });
      } catch (thrown) {
        update(sign, { state: "failed", error: `The provider's CLI could not be started: ${messageOf(thrown)}` });
        return;
      }
      sign.child = child;
      child.onStdout((chunk) => {
        sign.stdout = keep(sign.stdout + chunk);
        if (sign.state.state !== "starting") return;
        const url = sign.program.verificationUrl(sign.stdout);
        if (url !== null) update(sign, { state: "awaiting-code", url });
      });
      child.onStderr((chunk) => (sign.stderr = keep(sign.stderr + chunk)));
      child.onExit((code, error) => void exited(sign, code, error));
    };

    /** A new sign-in of `account`, `starting`, ten minutes from now. */
    const fresh = (account: AccountRecord, program: SignInProgram): Running => {
      const now = clock.now();
      const directory = account.directory.path;
      return {
        accountId: account.id,
        label: account.label,
        provider: account.provider,
        directory,
        program,
        state: {
          accountId: account.id,
          state: "starting",
          url: null,
          startedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + SIGN_IN_EXPIRY_MS).toISOString(),
          fallback: program.fallback(directory, likelyExecutable(account.provider, program)),
          error: null,
        },
        child: null,
        timer: null,
        completing: false,
        unrecorded: null,
        stdout: "",
        stderr: "",
      };
    };

    /** Replaces the latest sign-in with `sign` and sets it going. */
    const begin = (sign: Running): void => {
      current = sign;
      void launch(sign);
    };

    const notHeld = (accountId: string): SignInAnswer => ({
      aggregate: stream,
      rejected: { code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } },
    });

    const refuse = (reason: string, message: string, data: Record<string, string> = {}): SignInAnswer => ({
      aggregate: stream,
      rejected: { code: "conflict", message, data: { reason, ...data } },
    });

    /**
     * Applies a command's transition once it has committed, through the same
     * guard `update` keeps: never over a sign-in that has ended, been
     * replaced or is completing, nor once the environment is closing. The log
     * runs a command's callbacks in the commit's own turn, before any process
     * event can land (`signin-director.test.ts` pins it), so this refuses
     * nothing today; it keeps a later change to that ordering from
     * overwriting what the process decided, or re-arming its expiry.
     */
    const settle = (sign: Running, next: SignIn): boolean => {
      if (closed || current !== sign || ended(sign.state) || sign.completing) return false;
      sign.state = next;
      return true;
    };

    const accepted = (state: SignIn, context: CommandContext, then: () => void): SignInAnswer => {
      context.tx.afterCommit(then);
      return { aggregate: stream, result: { signIn: state }, events: [noticeOf(state)] };
    };

    /**
     * A sign-in the last run of the environment left running ended with it:
     * its process is gone. The latest notice is closed with a `cancelled`
     * one, so `environment.subscribe` never replays a live-looking sign-in.
     */
    const closeLeftOver = (): void => {
      const [row] = log.read<{ payload: string }>(
        "SELECT payload FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'signin.updated' ORDER BY sequence DESC LIMIT 1",
        ENVIRONMENT_STREAM_KIND,
        environmentId,
      );
      if (row === undefined) return;
      const left = SignInSchema.safeParse(JSON.parse(row.payload));
      if (!left.success || ended(left.data)) return;
      try {
        log.append(stream, [noticeOf({ ...left.data, state: "cancelled", error: "The environment restarted.", cause: "restarted" })], { actor: SIGN_IN_ACTOR });
      } catch (error) {
        console.error("Closing the sign-in the last run left open failed:", error);
      }
    };
    closeLeftOver();

    return {
      ready(account) {
        if (programOf(account.provider) === undefined) return { started: false, reason: "signin_unavailable", message: unavailableMessage(account) };
        const holder = running();
        if (holder !== null) {
          return { started: false, reason: "signin_running", message: `${heldMessage(holder)} Sign ${account.label} in once it has ended.` };
        }
        return { started: true, message: null };
      },

      start(account) {
        const program = programOf(account.provider);
        // `ready` said so inside the add's transaction, and nothing ran between it and this commit.
        if (closed || program === undefined || running() !== null) return;
        const sign = fresh(account, program);
        try {
          log.append(stream, [noticeOf(sign.state)], { actor: SIGN_IN_ACTOR });
        } catch (error) {
          console.error(`Noticing the sign-in of ${account.label} failed; it is not started:`, error);
          return;
        }
        begin(sign);
      },

      begin(params, context) {
        const account = port.account(params.accountId);
        if (account === null) return notHeld(params.accountId);
        const program = programOf(account.provider);
        if (program === undefined) return refuse("signin_unavailable", unavailableMessage(account), { accountId: account.id });
        const holder = running();
        if (holder !== null) return refuse("signin_running", heldMessage(holder), { accountId: holder.accountId, label: holder.label });
        const sign = fresh(account, program);
        return accepted(sign.state, context, () => begin(sign));
      },

      code(params, context) {
        if (port.account(params.accountId) === null) return notHeld(params.accountId);
        const sign = running();
        if (sign === null || sign.accountId !== params.accountId || sign.state.state !== "awaiting-code" || sign.completing) {
          const what =
            sign === null || sign.accountId !== params.accountId
              ? `No sign-in of ${params.accountId} is running.`
              : sign.completing
                ? `The sign-in of ${sign.label} is completing: its status is being read.`
                : `The sign-in of ${sign.label} is ${sign.state.state}, not awaiting a code.`;
          return refuse("not_awaiting_code", what);
        }
        const next: SignIn = { ...sign.state, state: "submitting", expiresAt: new Date(clock.now().getTime() + SIGN_IN_EXPIRY_MS).toISOString() };
        return accepted(next, context, () => {
          if (!settle(sign, next)) return;
          arm(sign);
          try {
            // The code goes to the process and nowhere else: never into an event, a receipt or a log line.
            sign.child?.write(`${params.code}\n`);
          } catch (error) {
            update(sign, { state: "failed", error: `The code could not be written to the provider's CLI: ${messageOf(error)}` });
          }
        });
      },

      cancel(params, context) {
        if (port.account(params.accountId) === null) return notHeld(params.accountId);
        const sign = current;
        if (sign === null || sign.accountId !== params.accountId) return refuse("no_signin", `No sign-in of ${params.accountId} is the environment's latest.`);
        // Already ended: answered as it ended, changing nothing.
        if (ended(sign.state)) return { aggregate: stream, result: { signIn: sign.state } };
        if (sign.completing) return refuse("signin_completing", `The sign-in of ${sign.label} is completing: its status is being read, and it ends as that read says.`);
        const next: SignIn = { ...sign.state, state: "cancelled", error: null };
        return accepted(next, context, () => {
          if (settle(sign, next)) stop(sign);
        });
      },

      latest: () => current?.state ?? null,

      removed(accountId) {
        const sign = running();
        // A sign-in that is completing ends as its status read says, which finds the account gone.
        if (sign !== null && sign.accountId === accountId && !sign.completing) update(sign, { state: "cancelled", error: "The account was removed.", cause: "account-removed" });
      },

      close() {
        closed = true;
        closing.abort();
        if (current !== null) stop(current);
      },
    };
  };
