import { CHAT_COMPLETIONS_PATH, COMPLETIONS_NAMESPACE, CompletionsModelList, MODELS_PATH, type CompletionsModel, type Mode } from "@agent-harness/contracts";
import type { ConnectionCredential, Observable, SessionProjection } from "@agent-harness/client-runtime";
import type { SelectionOutcome, SelectionRefusal, TerminalSelection } from "../startup/selection.js";
import { nameOf } from "../view.js";
import { AnswerAbandoned, readAnswer, refusalOf, type Head, type Learned } from "./answer.js";
import { cancelTurn, readerOf } from "./cancel.js";
import { PrintFailure } from "./failure.js";
import { listedModel } from "./model.js";
import { formatWriter, narrator, type PrintFormat } from "./output.js";
import { targetOf, type Target } from "./session.js";

/**
 * `agent-harness tui -p` (docs/specs/switch-over.md, "Phase-D commands and
 * parity"; #1180): one answer, printed. The environment is the one the
 * terminal UI would show (the screenless selection), the turn goes through
 * the completions surface every program uses (ADR 0015) on the selection's
 * credential, and standard output carries only what the format prints.
 */

/** What `-p` asks, as the CLI parsed it. */
export interface PrintRequest {
  /** The prompt: never empty. */
  readonly prompt: string;
  readonly format: PrintFormat;
  /** `--model`: a listed id, or a model or family of the session's account. */
  readonly model?: string | undefined;
  /** `--mode`: the permission mode the turn asks for. */
  readonly mode?: Mode | undefined;
  /** `--effort`: the reasoning effort. */
  readonly effort?: string | undefined;
}

/** The process as printing uses it: its two streams, its two signals, and the network. */
export interface PrintIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Settles on SIGINT. */
  readonly interrupted: Promise<unknown>;
  /** Settles when standard output can take nothing more: its reader went away. */
  readonly outputClosed: Promise<unknown>;
  /** The completions routes' HTTP. */
  readonly fetch: typeof globalThis.fetch;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A request of the completions routes; a network failure is the environment out of reach, an abort the print let go of. */
const ask = async (io: PrintIo, environment: string, url: string, init: RequestInit & { readonly signal: AbortSignal }): Promise<Response> => {
  try {
    return await io.fetch(url, init);
  } catch (error) {
    if (init.signal.aborted) throw new AnswerAbandoned();
    throw new PrintFailure(`${environment} could not be reached: ${messageOf(error)}.`);
  }
};

/** `GET /v1/models` on the environment, as its credential may read it. */
const listModels = async (io: PrintIo, environment: string, credential: ConnectionCredential, learned: Learned, signal: AbortSignal): Promise<readonly CompletionsModel[]> => {
  const response = await ask(io, environment, `${credential.origin}${MODELS_PATH}`, { headers: { authorization: `Bearer ${credential.token}` }, signal });
  if (!response.ok) throw await refusalOf(response, learned, environment);
  const listing = CompletionsModelList.safeParse(await response.json().catch(() => null));
  if (!listing.success) throw new PrintFailure(`${environment} listed its models in a shape this terminal does not read.`);
  return listing.data.data;
};

/**
 * The account a turn runs on and the model chosen for it: what a session's
 * latest run used; else, for a new session or one with no run yet, the
 * new-session card's presets (`projections.newSession`).
 */
const accountFor = async (
  selection: TerminalSelection,
  target: Target,
  environment: string,
): Promise<{ readonly id: string; readonly label: string | undefined; readonly model: string | undefined }> => {
  const ran = target.sessionId === null ? null : target.summary;
  if (ran?.accountId != null && ran.model !== null) return { id: ran.accountId, label: undefined, model: ran.model };
  const { account, model } = await selection.newSessionPresets();
  if (account.value === null) throw new PrintFailure(`${environment} has no signed-in account to run the turn on.`);
  return { id: account.value.id, label: account.value.label, model: model.value?.id };
};

/** The turn as the completions surface takes it (claude-adapter spec; #1179): the user's message, streamed with usage, unattended, no tools of the caller's. */
const turnBody = (request: PrintRequest, model: CompletionsModel, target: Target) => ({
  model: model.id,
  messages: [{ role: "user", content: request.prompt }],
  stream: true,
  stream_options: { include_usage: true },
  [COMPLETIONS_NAMESPACE]: {
    ...(target.sessionId === null ? target.workspace !== undefined && { workspace: target.workspace } : { sessionId: target.sessionId }),
    ...(request.mode !== undefined && { permissionMode: request.mode }),
    ...(request.effort !== undefined && { thinking: request.effort }),
    attended: false,
  },
});

/** Why a print stopped before its answer's end: SIGINT, or standard output closing. */
type Stop = "interrupted" | "output-closed";

/**
 * Prints one answer: chooses the environment with `select`, sends the
 * prompt and writes what comes back in the format asked for; resolves to
 * the exit code: 0 for a completed turn, 1 for anything else, 2 for
 * selectors that cannot work together, 130 after SIGINT. SIGINT takes the
 * turn back (`cancelTurn`) before the answer is let go of; standard output
 * closing lets it go at once, the turn going on. Whatever the print started
 * is closed by the time it resolves.
 */
export const printAnswer = async (select: () => Promise<SelectionOutcome>, request: PrintRequest, io: PrintIo): Promise<number> => {
  const startedAt = performance.now();
  const learned: Learned = { environmentId: null, sessionId: null, runId: null, text: "", usage: null, reason: "error", error: null, finished: false, completed: false };
  let stopped: Stop | null = null;
  const writer = formatWriter(request.format, (text) => {
    if (stopped !== "output-closed") io.stdout(text);
  });
  const end = (exit: number): number => {
    const { sessionId, runId, text, usage, reason, error } = learned;
    const durationMs = Math.round(performance.now() - startedAt);
    writer.end({ type: "result", environmentId: learned.environmentId, sessionId, runId, text, usage, durationMs, reason, error }, learned.completed);
    return exit;
  };
  const say = (line: string) => io.stderr(`${line}\n`);
  const fail = (message: string, exit: 1 | 2 = 1): number => {
    learned.error = message;
    say(message);
    return end(exit);
  };

  // A stop lets go of what the print waits on; after SIGINT on a turn sent, once the turn is taken back.
  const letGo = new AbortController();
  const stoppedBy = new Promise<Stop>((resolve) => {
    void io.interrupted.then(() => resolve("interrupted"));
    void io.outputClosed.then(() => resolve("output-closed"));
  });
  const abandoned = new Promise<never>((_, reject) => letGo.signal.addEventListener("abort", () => reject(new AnswerAbandoned())));
  abandoned.catch(() => undefined);
  /** A step before the turn is sent, given up when the print is let go of. */
  const until = <T>(step: Promise<T>): Promise<T> => Promise.race([step, abandoned]);
  /** Set once the turn is sent: settles with what the answer's first chunk says of it, or null when the answer ends with nothing to take back. */
  let headed: Promise<Head | null> | undefined;
  let cancelled: Promise<string | null> = Promise.resolve(null);
  let over = false;

  const outcome = await select().catch((error: unknown): SelectionRefusal => ({ ok: false, reason: "unreachable", message: messageOf(error) }));
  if (!outcome.ok) return fail(outcome.message);
  const { selection } = outcome;
  const environmentId = selection.environment.environmentId;
  learned.environmentId = environmentId;
  let following: { readonly session: Observable<SessionProjection>; readonly stop: () => void } | undefined;
  let turn: Head | undefined;
  /** A queued turn's run is the one that read its message, once the session's stream says which. */
  const readBy = () => {
    if (turn?.delivery === "queued" && following !== undefined) learned.runId = readerOf(following.session.read(), turn.messageId) ?? learned.runId;
  };
  let answered: () => void = () => undefined;
  const answerOver = new Promise<void>((resolve) => (answered = resolve));
  void stoppedBy.then((why) => {
    if (over) return;
    stopped = why;
    if (why === "interrupted" && headed !== undefined) {
      cancelled = headed.then((head) => (head === null || following === undefined ? null : cancelTurn(selection.runtime, environmentId, head, following.session, answerOver)));
      void cancelled.finally(() => letGo.abort());
    } else letGo.abort();
  });

  try {
    const { credential } = selection;
    const environment = nameOf(selection.environment);
    const target = await until(targetOf(selection));
    const account = await until(accountFor(selection, target, environment));
    const listing = await listModels(io, environment, credential, learned, letGo.signal);
    const model = listedModel(listing, account.id, request.model, account.model);
    if (model === undefined) {
      const label = account.label ?? listing.find((entry) => entry[COMPLETIONS_NAMESPACE].accountId === account.id)?.[COMPLETIONS_NAMESPACE].account ?? account.id;
      throw new PrintFailure(
        request.model === undefined
          ? `${environment} offers ${label} no model to run the turn on.`
          : `${environment} offers ${label} no model ${request.model}: GET ${MODELS_PATH} lists what each account offers.`,
      );
    }
    if (stopped !== null) throw new AnswerAbandoned();

    let heard: (head: Head | null) => void = () => undefined;
    headed = new Promise((resolve) => (heard = resolve));
    const response = await ask(io, environment, `${credential.origin}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(turnBody(request, model, target)),
      signal: letGo.signal,
    }).catch((error: unknown) => {
      heard(null);
      throw error;
    });
    if (!response.ok || response.body === null) {
      heard(null);
      throw await refusalOf(response, learned, environment);
    }
    try {
      await readAnswer(response.body, {
        environment,
        learned,
        writer,
        narrate: narrator(io.stderr),
        signal: letGo.signal,
        head: (head) => {
          // Where the turn's message went is the session's own stream's to say from here on.
          const session = selection.runtime.projections.session(environmentId, head.sessionId);
          following = { session, stop: session.subscribe(() => undefined) };
          turn = head;
          heard(head);
        },
      });
    } finally {
      heard(null);
      answered();
    }
    if (stopped !== null) throw new AnswerAbandoned();
    over = true;
    readBy();
    return end(learned.completed ? 0 : 1);
  } catch (error) {
    if (stopped === "output-closed") {
      say("Standard output closed before the answer was printed in full.");
      return 1;
    }
    if (stopped === "interrupted") {
      const sentence = await cancelled;
      readBy();
      if (!learned.finished) learned.reason = "interrupted";
      learned.error = sentence ?? (error instanceof PrintFailure ? error.message : "Interrupted before the turn was sent.");
      say(learned.error);
      return end(130);
    }
    // A failure is said in one line, as the result's error: an unforeseen one too, so a JSON format still ends with its result.
    return error instanceof PrintFailure ? fail(error.message, error.exit) : fail(messageOf(error));
  } finally {
    over = true;
    following?.stop();
    await selection.close();
  }
};
