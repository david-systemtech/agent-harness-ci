import {
  CHAT_COMPLETIONS_PATH,
  COMPLETIONS_NAMESPACE,
  MODELS_PATH,
  type ChatCompletionChunk,
  type CompletionsAnswerExtension,
  type CompletionsErrorDetail,
  type CompletionsModel,
  type CompletionUsage,
} from "@agent-harness/contracts";

/**
 * The completions surface's HTTP routes as a test answers them (claude-adapter
 * spec, "The completions surface"): `GET /v1/models` from a listing the test
 * gives, and each `POST /v1/chat/completions` held until the test refuses it
 * or opens its stream, then written by the test as SSE, byte by byte if it
 * likes. What the printer sends is kept as it was sent.
 */

/** One request the printer made of the routes. */
export interface Sent {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | null;
}

/** A turn sent, waiting for the test's answer. */
export interface Turn extends Sent {
  readonly body: Record<string, unknown>;
  /** Refuses the turn with `status` and the surface's error body. */
  refuse(status: number, body: unknown): void;
  /** Answers 200 and opens the stream for the test to write. */
  open(): AnswerStream;
}

export interface AnswerStream {
  /** Text as it is, in one piece. */
  write(text: string): void;
  /** Bytes as they are, however they cut the text. */
  bytes(bytes: Uint8Array): void;
  /** One chunk as an SSE `data:` event. */
  chunk(chunk: ChatCompletionChunk): void;
  /** The surface's keep-alive comment. */
  heartbeat(): void;
  /** `data: [DONE]`, then the end of the stream. */
  done(): void;
  /** Ends the stream with nothing more. */
  end(): void;
  /** Breaks the connection mid-answer. */
  fail(): void;
  /** Whether the printer let go of the answer (it aborted or stopped reading). */
  readonly abandoned: () => boolean;
  /** Calls `then` the moment the printer lets go of the answer. */
  onAbandoned(then: () => void): void;
}

export interface FakeCompletions {
  readonly fetch: typeof globalThis.fetch;
  /** Every request made, in order. */
  sent(): readonly Sent[];
  /** The next turn sent, once it is. */
  turn(): Promise<Turn>;
  /** What `GET /v1/models` answers from now on: the listing, or a refusal. */
  models(answer: readonly CompletionsModel[] | { readonly status: number; readonly body: unknown }): void;
}

const encoder = new TextEncoder();
const abortError = () => new DOMException("This operation was aborted", "AbortError");

export const fakeCompletions = (origin: string, listing: readonly CompletionsModel[] = []): FakeCompletions => {
  const sent: Sent[] = [];
  let models: readonly CompletionsModel[] | { readonly status: number; readonly body: unknown } = listing;
  const waiting: Turn[] = [];
  const takers: ((turn: Turn) => void)[] = [];
  const offer = (turn: Turn) => {
    const taker = takers.shift();
    if (taker) taker(turn);
    else waiting.push(turn);
  };

  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const request: Sent = { method, url, authorization: headers.get("authorization"), body };
    sent.push(request);
    if (!url.startsWith(origin)) throw new TypeError(`fetch failed: nothing answers at ${url}`);
    const path = url.slice(origin.length);
    if (method === "GET" && path === MODELS_PATH) {
      return Array.isArray(models) ? Response.json({ object: "list", data: models }) : Response.json((models as { body: unknown }).body, { status: (models as { status: number }).status });
    }
    if (method !== "POST" || path !== CHAT_COMPLETIONS_PATH || body === null) return Response.json({ error: { message: "Not here." } }, { status: 404 });
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      signal?.addEventListener("abort", () => {
        if (!settled) reject(abortError());
      });
      offer({
        ...request,
        body,
        refuse(status, refusal) {
          settled = true;
          resolve(Response.json(refusal, { status }));
        },
        open() {
          settled = true;
          // What the test wrote, served as the printer reads: a break comes after what was written before it, as on a socket.
          const queue: (Uint8Array | Error | "end")[] = [];
          let wake: (() => void) | undefined;
          let over = false;
          let abandoned = false;
          const watchers: (() => void)[] = [];
          const letGo = () => {
            if (abandoned) return;
            abandoned = true;
            for (const watcher of watchers.splice(0)) watcher();
          };
          const push = (item: Uint8Array | Error | "end") => {
            if (over) return;
            if (!(item instanceof Uint8Array)) over = true;
            queue.push(item);
            wake?.();
          };
          const stream = new ReadableStream<Uint8Array>(
            {
              pull: async (controller) => {
                while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
                const next = queue.shift() as Uint8Array | Error | "end";
                if (next === "end") controller.close();
                else if (next instanceof Error) controller.error(next);
                else controller.enqueue(next);
              },
              cancel: letGo,
            },
            { highWaterMark: 0 },
          );
          signal?.addEventListener("abort", () => {
            letGo();
            // An abort drops what was not read yet.
            queue.length = 0;
            over = false;
            push(abortError());
          });
          const bytes = (chunk: Uint8Array) => push(chunk);
          const write = (text: string) => bytes(encoder.encode(text));
          const end = () => push("end");
          resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }));
          return {
            write,
            bytes,
            chunk: (chunk) => write(`data: ${JSON.stringify(chunk)}\n\n`),
            heartbeat: () => write(": keep-alive\n\n"),
            done: () => {
              write("data: [DONE]\n\n");
              end();
            },
            end,
            fail: () => push(new TypeError("terminated")),
            abandoned: () => abandoned,
            onAbandoned: (then) => void (abandoned ? then() : watchers.push(then)),
          };
        },
      });
    });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    sent: () => sent,
    turn: () => {
      const turn = waiting.shift();
      return turn ? Promise.resolve(turn) : new Promise((resolve) => takers.push(resolve));
    },
    models: (answer) => void (models = answer),
  };
};

/** A model of the listing, as the surface names it: `<account label slug>/<model>`. */
export const listed = (slug: string, model: string, family: string, tier: number, account: { readonly id: string; readonly label: string }): CompletionsModel => ({
  id: `${slug}/${model}`,
  object: "model",
  created: 0,
  owned_by: "claude",
  family,
  tier,
  [COMPLETIONS_NAMESPACE]: { account: account.label, accountId: account.id },
});

/** One chunk of an answer, as the surface writes it: the delta, the harness's fields, and on a final chunk why it ended. */
export const chunkOf = (
  seq: number,
  fields: {
    readonly content?: string;
    readonly role?: true;
    readonly finish?: "stop" | "length" | "tool_calls" | "error";
    readonly ext?: Omit<CompletionsAnswerExtension, "seq">;
    readonly error?: CompletionsErrorDetail;
    readonly usage?: CompletionUsage;
  } = {},
): ChatCompletionChunk => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1_790_000_000,
  model: "work/claude-opus-5",
  choices:
    fields.usage !== undefined
      ? []
      : [
          {
            index: 0,
            delta: { ...(fields.role && { role: "assistant" as const }), ...(fields.content !== undefined && { content: fields.content }) },
            finish_reason: fields.finish ?? null,
          },
        ],
  ...(fields.usage !== undefined && { usage: fields.usage }),
  ...(fields.error !== undefined && { error: fields.error }),
  [COMPLETIONS_NAMESPACE]: { seq, ...fields.ext },
});
