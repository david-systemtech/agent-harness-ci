import {
  CHAT_COMPLETIONS_PATH,
  COMPLETIONS_NAMESPACE,
  ChatCompletionChunk,
  CompletionsModelList,
  MODELS_PATH,
  type CompletionsModel,
  type Mode,
} from "@agent-harness/contracts";
import type { SelectionOutcome } from "../startup/selection.js";
import { eventData } from "./sse.js";

/**
 * `agent-harness tui -p` (docs/specs/switch-over.md, "Phase-D commands and
 * parity"; #1180): one answer, printed. The environment is the one the
 * terminal UI would show (the screenless selection), the turn goes through
 * the completions surface every program uses (ADR 0015) on the selection's
 * credential, and standard output carries only what the format prints.
 */

/** What standard output carries: the answer's text, one JSON result, or each chunk as a JSON line and then the result. */
export const PRINT_FORMATS = ["text", "json", "stream-json"] as const;
export type PrintFormat = (typeof PRINT_FORMATS)[number];

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

/** The part of a listed model's id after the account's slug: the model's own id. */
const modelOf = (listedId: string): string => listedId.slice(listedId.indexOf("/") + 1);

/** `GET /v1/models` on the environment, as its credential may read it. */
const listModels = async (io: PrintIo, origin: string, token: string): Promise<readonly CompletionsModel[]> => {
  const response = await io.fetch(`${origin}${MODELS_PATH}`, { headers: { authorization: `Bearer ${token}` } });
  return CompletionsModelList.parse(await response.json()).data;
};

/**
 * Prints one answer: chooses the environment with `select`, sends the
 * prompt and writes what comes back in the format asked for; resolves to
 * the exit code. Whatever it started is closed by then.
 */
export const printAnswer = async (select: () => Promise<SelectionOutcome>, request: PrintRequest, io: PrintIo): Promise<number> => {
  const outcome = await select();
  if (!outcome.ok) return 1;
  const { selection } = outcome;
  try {
    const { credential, session } = selection;
    const presets = await selection.newSessionPresets();
    const listing = await listModels(io, credential.origin, credential.token);
    const model = listing.find((entry) => entry[COMPLETIONS_NAMESPACE].accountId === presets.account.value?.id && modelOf(entry.id) === presets.model.value?.id);
    if (model === undefined) return 1;
    const body = {
      model: model.id,
      messages: [{ role: "user", content: request.prompt }],
      stream: true,
      stream_options: { include_usage: true },
      [COMPLETIONS_NAMESPACE]: { workspace: session.workspace, attended: false },
    };
    const response = await io.fetch(`${credential.origin}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.body === null) return 1;
    for await (const data of eventData(response.body)) {
      const chunk = ChatCompletionChunk.parse(JSON.parse(data));
      const content = chunk.choices[0]?.delta.content;
      if (content !== undefined) io.stdout(content);
    }
    io.stdout("\n");
    return 0;
  } finally {
    await selection.close();
  }
};
