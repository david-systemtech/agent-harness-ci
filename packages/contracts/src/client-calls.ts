import { z } from "zod";
import { ChromeId } from "./browser-bridge.js";
import { PageCall } from "./browser-driver.js";
import { ClientSessionId, EnvironmentId, Timestamp } from "./primitives.js";

/**
 * Client-addressed calls (browser spec, "The browser relay"; ADR 0014;
 * #554): what only a client can do for a run, asked of the client session
 * that started it. The run's environment appends `client.call` to its
 * `environment` stream, addressed to that client session; every client
 * hears it and only the addressed one handles it, answering with
 * `client.answer` on the same connection before the call's deadline. A call
 * carries what to do and never its answer, which reaches the run alone.
 *
 * A `browser.chrome` call asks for a verb on a Chrome paired with another
 * environment than the run's: the client performs it with
 * `browser.chromes.perform` on its local connection to that environment
 * (the bootstrap grant's), so only a client on the Chrome's machine can.
 */

/** The kinds of call an environment addresses to a client: a verb on a Chrome paired with that client's local environment. */
export const CLIENT_CALL_KINDS = ["browser.chrome"] as const;
export type ClientCallKind = (typeof CLIENT_CALL_KINDS)[number];

/** The longest answer a client sends, its result or its error as JSON in UTF-8: 8 MiB. */
export const CLIENT_ANSWER_MAX_BYTES = 8 * 1024 * 1024;

/** A call's id: a UUID the run's environment mints. */
export const ClientCallId = z.uuid().meta({ description: "A client-addressed call's id: a UUID the run's environment mints, which the answer names." });

/** A verb on a Chrome paired with another environment, as a `browser.chrome` call carries it. */
export const BrowserChromeCall = PageCall.extend({
  environmentId: EnvironmentId.meta({ description: "The environment the Chrome is paired with, which the client reaches through its local connection." }),
  chromeId: ChromeId.nullable().meta({ description: "The Chrome to drive; null for the plain My Chrome of that environment, the one paired Chrome connected there." }),
  deadline: Timestamp.meta({
    description: "When the run stops waiting for the answer, on the run environment's clock: the verb's deadline after the call was made. A later answer is dropped.",
  }),
}).meta({
  description:
    "A verb for one session's page on a Chrome paired with another environment: the Chrome's environment and id, the page key, the verb and its arguments, a one-time allowance when a person allowed a denylisted address, and the deadline.",
});
export type BrowserChromeCall = z.infer<typeof BrowserChromeCall>;

/** `client.call`'s payload: the call, the client session it is for, its kind and what the kind carries. */
export const ClientCallPayload = z
  .discriminatedUnion("kind", [
    z.object({
      callId: ClientCallId,
      clientSessionId: ClientSessionId.meta({
        description: "The client session the call is for: the one that started the run, or, for a run the environment started itself, the one that started the session's latest run a client started.",
      }),
      kind: z.literal("browser.chrome").meta({ description: "A verb on a Chrome paired with the client's local environment." }),
      payload: BrowserChromeCall,
    }),
  ])
  .meta({ description: "client.call: a call addressed to one client session, which answers it with client.answer before its deadline." });
export type ClientCallPayload = z.infer<typeof ClientCallPayload>;

/** Why a client could not do what a call asked: a code and the sentence the run reads. */
const ClientCallError = z
  .object({
    code: z.string().min(1).max(64).meta({ description: "unsupported: the client has no handler for the call's kind; handler_failed: its handler failed; or a code a client names." }),
    message: z.string().meta({ description: "What went wrong, a sentence the run reads." }),
  })
  .meta({ description: "Why the client could not do what the call asked." });

/** `client.answer`'s params: the call's id with the result, or with the error. */
export const ClientAnswer = z
  .object({
    callId: ClientCallId,
    ok: z.boolean().meta({ description: "true with result: the client did what the call asked; false with error: it could not." }),
    result: z.json().optional().meta({ description: "With ok: what the client's handler answered (null for nothing); for browser.chrome, the verb's outcome." }),
    error: ClientCallError.optional(),
  })
  .refine((answer) => (answer.ok ? answer.result !== undefined && answer.error === undefined : answer.error !== undefined && answer.result === undefined), {
    message: "An answer carries a result with ok, or an error without it.",
  })
  .meta({ description: `A client's answer to a call addressed to it: ok with the result, or not ok with the error; at most ${CLIENT_ANSWER_MAX_BYTES} bytes of either.` });
export type ClientAnswer = z.infer<typeof ClientAnswer>;
