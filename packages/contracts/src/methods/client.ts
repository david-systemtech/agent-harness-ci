import { z } from "zod";
import { ClientAnswer } from "../client-calls.js";
import { defineMethod } from "../method.js";

/**
 * A client's answer to a call its environment addressed to it (browser
 * spec, "The browser relay"; #554): a request that appends nothing, taken
 * only from the client session the call is for (any other is `forbidden`
 * with reason `addressed`). An answer for a call the environment does not
 * know, one past its deadline or one answered already is accepted with
 * `taken: false`, so a client's resend after a reconnect is harmless. A
 * result or an error over `CLIENT_ANSWER_MAX_BYTES` is refused
 * `invalid_params`, and the run reads that the answer was too large.
 */
export const clientAnswer = defineMethod({
  name: "client.answer",
  scope: "runs:drive",
  kind: "query",
  params: ClientAnswer,
  result: z
    .object({ taken: z.boolean().meta({ description: "Whether the call took this answer: false for a call unknown, past its deadline or answered already." }) })
    .meta({ description: "Whether the answer reached the run." }),
  errors: [],
});
