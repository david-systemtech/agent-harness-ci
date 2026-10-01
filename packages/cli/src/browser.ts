import { PRODUCT_NAME, type EnvironmentNotice, type ResultOf } from "@agent-harness/contracts";
import { defaultDataDirectory, type Clock, type Timer } from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "./args.js";
import { LocalFailure, withLocalSession, type LocalCall, type LocalNotices, type Net } from "./local-session.js";

/**
 * The `browser` verbs (browser spec, "The extension, its folder and its
 * listener"; #560): `browser pair`, pairing a Chrome with the environment
 * on this machine from a terminal, for a machine with no desktop window.
 * It reaches the environment through the bootstrap grant, as `pair` does
 * (`local-session.ts`), and prints the Browser card's steps as lines: the
 * folder Chrome loads and how to load it, the extension loading, a code
 * with its countdown, and the Chrome that paired.
 */

export const BROWSER_USAGE = [`${PRODUCT_NAME} browser pair [--data-dir <path>] [--port <n>]`] as const;

export interface BrowserContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly net: Net;
  /** What the code's countdown runs on: the machine's clock, which the environment on it keeps too. */
  readonly clock: Pick<Clock, "now" | "setTimeout">;
  /** Resolves when the verb is asked to stop: SIGINT or SIGTERM. */
  readonly stopRequested: () => Promise<unknown>;
}

/** The label the verb's local client session is exchanged under, as `access.sessions.list` shows it. */
const LABEL = `${PRODUCT_NAME} browser pair`;

type LiveCode = ResultOf<"browser.pairing.code">;

/** How the wait for a paired Chrome ended: a Chrome paired, by its name, or the verb was asked to stop. */
type Ending = { readonly paired: string } | { readonly stopped: true };

const MINUTE_MS = 60_000;

/** `ms` as minutes and seconds, `4:59`, a part second counting as a whole one. */
const clockTime = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The Browser card's Load sub-step as lines, in Chrome-only copy (ADR 0024; setup spec, the Browser card). */
const loadLines = (folder: string): string =>
  [
    "Load the extension in Chrome from this folder:",
    "",
    `  ${folder}`,
    "",
    "  1. Open chrome://extensions.",
    "  2. Turn on Developer mode.",
    "  3. Click Load unpacked and choose this folder.",
    "",
    "",
  ].join("\n");

/**
 * The wait for a paired Chrome: `run` is the verb's work on the wire, and
 * settles once a Chrome pairs or `stop` is called, or fails with what went
 * wrong. Nothing is printed and no timer is left once it has settled or
 * `close` was called.
 */
const pairingWait = (context: Pick<BrowserContext, "stdout" | "clock">) => {
  let ended = false;
  let settle!: { readonly resolve: (ending: Ending) => void; readonly reject: (error: unknown) => void };
  const ending = new Promise<Ending>((resolve, reject) => (settle = { resolve, reject }));
  let timer: Timer | undefined;
  /** Whether the Load lines are printed, an unpaired extension was seen, and the verb said it loaded. */
  let instructed = false;
  let seen = false;
  let saidLoaded = false;

  const say = (text: string) => {
    if (!ended) context.stdout(text);
  };
  const close = () => {
    ended = true;
    timer?.cancel();
  };
  const end = (how: Ending) => {
    if (ended) return;
    close();
    settle.resolve(how);
  };
  const fail = (error: unknown) => {
    if (ended) return;
    close();
    settle.reject(error);
  };

  /** An unpaired extension holds a socket: said once, after the Load lines. */
  const extensionLoaded = () => {
    seen = true;
    if (!instructed || saidLoaded) return;
    saidLoaded = true;
    say("The extension has loaded in Chrome and waits for the code.\n");
  };

  const hear = (notice: EnvironmentNotice) => {
    if (notice.type === "extension.seen") return extensionLoaded();
    if (notice.type === "chrome.updated" && notice.payload.change === "paired") {
      say(`Paired the Chrome named "${notice.payload.name}".\n`);
      end({ paired: notice.payload.name });
    }
  };

  /** How long `live` has left on the machine's clock. */
  const leftOn = (live: LiveCode): number => Date.parse(live.expiresAt) - context.clock.now().getTime();

  /**
   * The countdown of `live`: a line at each whole minute left, then, at its
   * expiry, the environment's next code. `above` is the minute last said, so
   * a timer that fires early never says one twice.
   */
  const countdown = (call: LocalCall, live: LiveCode, above = Number.POSITIVE_INFINITY) => {
    if (ended) return;
    const left = leftOn(live);
    const mark = Math.max(0, Math.min(above - MINUTE_MS, (Math.ceil(left / MINUTE_MS) - 1) * MINUTE_MS));
    timer = context.clock.setTimeout(() => {
      if (mark === 0) return void renew(call, live);
      say(`${clockTime(mark)} left on the code.\n`);
      countdown(call, live, mark);
    }, Math.max(0, left - mark));
  };

  const show = (call: LocalCall, live: LiveCode, intro: string) => {
    say(`${intro}\n\n  ${live.code}\n\nIt is good for ${clockTime(leftOn(live))}.\n`);
    countdown(call, live);
  };

  /** The expired code's successor: the environment mints one once its own clock has passed the expiry, and answers the same code until then. */
  const renew = async (call: LocalCall, expired: LiveCode) => {
    try {
      const live = await call("browser.pairing.code", {});
      if (live.code === expired.code) return countdown(call, live);
      show(call, live, "That code expired. Type this one instead:");
    } catch (error) {
      fail(error);
    }
  };

  const begin = async (call: LocalCall, notices: LocalNotices) => {
    // Followed before anything is read, so no notice falls between the read and the following.
    await notices(hear);
    const status = await call("browser.status", {});
    if (status.listener.state === "not-listening") throw new LocalFailure(status.listener.message);
    if (status.folder.problem !== null) throw new LocalFailure(status.folder.problem);
    say(loadLines(status.folder.path));
    instructed = true;
    if (seen || status.unpairedConnected) extensionLoaded();
    show(call, await call("browser.pairing.code", {}), "Then type this code on the extension's options page:");
  };

  return {
    run: (call: LocalCall, notices: LocalNotices): Promise<Ending> => {
      begin(call, notices).catch(fail);
      return ending;
    },
    stop: () => end({ stopped: true }),
    close,
  };
};

/**
 * `browser pair`: pairs a Chrome with the environment running on this
 * machine as this OS user. It prints the extension's folder and how to load
 * it, says when the extension has loaded, prints a code from
 * `browser.pairing.code` with its countdown and the next code when it
 * expires, and waits for the paired Chrome, which it names. It exits 0
 * once a Chrome has paired; 1 with a sentence when no environment answers,
 * the listener is not listening or the folder lacks the extension, or when
 * it is stopped first. Stopped, it revokes its client session and leaves
 * the environment as it was: a pairing is the environment's to make whole.
 */
const pair = async (args: readonly string[], context: BrowserContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" } });
  const target = { dataDir: values["data-dir"] ?? defaultDataDirectory(), port: parsePort(values.port, 1) };
  const wait = pairingWait(context);
  void context.stopRequested().then(wait.stop);
  try {
    const ending = await withLocalSession(target, context.net, LABEL, wait.run);
    if ("paired" in ending) return 0;
    context.stderr("Stopped before a Chrome paired.\n");
    return 1;
  } finally {
    wait.close();
  }
};

/** The `browser` verbs by name. */
const VERBS: Readonly<Record<string, (args: readonly string[], context: BrowserContext) => Promise<number>>> = { pair };

/**
 * `browser`: runs the verb `args` name. Exits as the verb does, 1 with a
 * plain sentence when no environment answers or it refuses, and 2 (the
 * CLI's usage error) on arguments it cannot parse.
 */
export const browser = async (args: readonly string[], context: BrowserContext): Promise<number> => {
  const [verb, ...rest] = args;
  const run = verb === undefined || !Object.hasOwn(VERBS, verb) ? undefined : VERBS[verb];
  if (run === undefined) throw new UsageError(verb === undefined ? "browser takes a verb: pair." : `Unknown browser verb ${verb}.`);
  try {
    return await run(rest, context);
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};
