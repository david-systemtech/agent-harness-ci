import {
  CHAT_COMPLETIONS_PATH,
  COMPLETIONS_NAMESPACE,
  ChatCompletionChunk,
  CompletionsErrorBody,
  CompletionsModelList,
  MODELS_PATH,
  type CompletionsModel,
  type CompletionUsage,
  type Mode,
  type RunEndReason,
} from "@agent-harness/contracts";
import type { ConnectionCredential } from "@agent-harness/client-runtime";
import type { SelectionOutcome, TerminalSelection } from "../startup/selection.js";
import { nameOf } from "../view.js";
import { formatWriter, narrator, type FormatWriter, type Narrator, type PrintFormat } from "./output.js";
import { PrintFailure } from "./failure.js";
import { listedModel } from "./model.js";
import { targetOf, type Target } from "./session.js";
import { eventData } from "./sse.js";

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

/** What the print has learned, for its result. */
interface Learned {
  environmentId: string | null;
  sessionId: string | null;
  runId: string | null;
  text: string;
  usage: CompletionUsage | null;
  reason: RunEndReason;
  error: string | null;
  /** The answer ended with its run completed, and nothing it sent still waits. */
  completed: boolean;
}

/** The surface's refusal of a request, in its words, with the session and run it names; else the status. */
const refusalOf = async (response: Response, learned: Learned, what: string): Promise<PrintFailure> => {
  const parsed = CompletionsErrorBody.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return new PrintFailure(`${what} answered ${response.status}.`);
  const fields = parsed.data[COMPLETIONS_NAMESPACE];
  if (fields?.sessionId !== undefined) learned.sessionId = fields.sessionId;
  if (fields?.runId !== undefined) learned.runId = fields.runId;
  if (fields?.ended !== undefined) learned.reason = fields.ended.reason;
  return new PrintFailure(parsed.data.error.message);
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A request of the completions routes; a network failure is the environment out of reach. */
const ask = async (io: PrintIo, environment: string, url: string, init: RequestInit): Promise<Response> => {
  try {
    return await io.fetch(url, init);
  } catch (error) {
    throw new PrintFailure(`${environment} could not be reached: ${messageOf(error)}.`);
  }
};

/** `GET /v1/models` on the environment, as its credential may read it. */
const listModels = async (io: PrintIo, environment: string, credential: ConnectionCredential, learned: Learned): Promise<readonly CompletionsModel[]> => {
  const response = await ask(io, environment, `${credential.origin}${MODELS_PATH}`, { headers: { authorization: `Bearer ${credential.token}` } });
  if (!response.ok) throw await refusalOf(response, learned, environment);
  const listing = CompletionsModelList.safeParse(await response.json().catch(() => null));
  if (!listing.success) throw new PrintFailure(`${environment} listed its models in a shape this terminal does not read.`);
  return listing.data.data;
};

/** One event's data, parsed as JSON and read as a chunk. */
const chunkOf = (data: string): { readonly raw: unknown; readonly chunk: ChatCompletionChunk } => {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new PrintFailure("The answer sent something that is not JSON.");
  }
  const parsed = ChatCompletionChunk.safeParse(raw);
  if (!parsed.success) throw new PrintFailure("The answer sent something that is not a completion chunk.");
  return { raw, chunk: parsed.data };
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

/** Reads the streamed answer into `learned`, handing each chunk to `writer` as it comes. */
const readAnswer = async (body: ReadableStream<Uint8Array>, environment: string, learned: Learned, writer: FormatWriter, narrate: Narrator): Promise<void> => {
  let finished = false;
  /** The final chunk's error: said once the usage after it is read too. */
  let failed: string | undefined;
  const events = eventData(body);
  for (;;) {
    let next: IteratorResult<string>;
    try {
      next = await events.next();
    } catch (error) {
      throw new PrintFailure(`The answer from ${environment} broke off: ${messageOf(error)}.`);
    }
    if (next.done === true) break;
    let raw: unknown;
    let chunk: ChatCompletionChunk;
    try {
      ({ raw, chunk } = chunkOf(next.value));
    } catch (error) {
      await events.return();
      throw error;
    }
    const fields = chunk[COMPLETIONS_NAMESPACE];
    if (fields.sessionId !== undefined) learned.sessionId = fields.sessionId;
    if (fields.runId !== undefined) learned.runId = fields.runId;
    const choice = chunk.choices[0];
    const content = choice?.delta.content;
    if (content !== undefined) learned.text += content;
    if (chunk.usage !== undefined) learned.usage = chunk.usage;
    writer.chunk(raw, content);
    if (fields.clamped != null) narrate.clamped(fields.clamped);
    if (fields.ignored !== undefined) narrate.ignored(fields.ignored);
    if (fields.activity !== undefined) narrate.activity(fields.activity);
    if (choice?.finish_reason == null) continue;
    finished = true;
    if (fields.ended !== undefined) learned.reason = fields.ended.reason;
    learned.completed = choice.finish_reason === "stop" && fields.ended?.reason === "completed" && fields.waiting === undefined;
    failed = chunk.error?.message ?? (fields.waiting === undefined ? undefined : "The message still waits in the session's queue: no run has read it.");
  }
  if (!finished) throw new PrintFailure("The answer ended before its run did.");
  if (failed !== undefined) throw new PrintFailure(failed);
};

/**
 * Prints one answer: chooses the environment with `select`, sends the
 * prompt and writes what comes back in the format asked for; resolves to
 * the exit code. Whatever it started is closed by then.
 */
export const printAnswer = async (select: () => Promise<SelectionOutcome>, request: PrintRequest, io: PrintIo): Promise<number> => {
  const startedAt = performance.now();
  const writer = formatWriter(request.format, io.stdout);
  const learned: Learned = { environmentId: null, sessionId: null, runId: null, text: "", usage: null, reason: "error", error: null, completed: false };
  const end = (code: number): number => {
    const { completed, ...result } = learned;
    writer.end({ type: "result", ...result, durationMs: Math.round(performance.now() - startedAt) }, completed);
    return code;
  };
  const fail = (message: string, exit: 1 | 2 = 1): number => {
    learned.error = message;
    io.stderr(`${message}\n`);
    return end(exit);
  };

  const outcome = await select();
  if (!outcome.ok) return fail(outcome.message);
  const { selection } = outcome;
  learned.environmentId = selection.environment.environmentId;
  try {
    const { credential } = selection;
    const environment = nameOf(selection.environment);
    const target = await targetOf(selection);
    const account = await accountFor(selection, target, environment);
    const listing = await listModels(io, environment, credential, learned);
    const model = listedModel(listing, account.id, request.model, account.model);
    if (model === undefined) {
      const label = account.label ?? listing.find((entry) => entry[COMPLETIONS_NAMESPACE].accountId === account.id)?.[COMPLETIONS_NAMESPACE].account ?? account.id;
      throw new PrintFailure(
        request.model === undefined
          ? `${environment} offers ${label} no model to run the turn on.`
          : `${environment} offers ${label} no model ${request.model}: GET ${MODELS_PATH} lists what each account offers.`,
      );
    }
    const body = {
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
    };
    const response = await ask(io, environment, `${credential.origin}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok || response.body === null) throw await refusalOf(response, learned, environment);
    await readAnswer(response.body, environment, learned, writer, narrator(io.stderr));
    return end(learned.completed ? 0 : 1);
  } catch (error) {
    if (error instanceof PrintFailure) return fail(error.message, error.exit);
    throw error;
  } finally {
    await selection.close();
  }
};
