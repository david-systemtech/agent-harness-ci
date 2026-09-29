import { describe, expect, it } from "vitest";
import type { DispatchAnswer } from "../outbox/outbox.js";
import { answerPrompt } from "./answer.js";

/**
 * What an answer's failure says (`prompts/answer.ts`): one line, and whether
 * the runtime's outbox has already raised its one notice for it (a
 * rejection, a drop) or none (refused at dispatch, the socket gone before
 * its turn, the runtime closed, the environment removed).
 */

type Answer = DispatchAnswer<"permissions.prompts.answer">;

const answering = (answer: Answer) => {
  const sent: unknown[] = [];
  const runtime = {
    commands: {
      dispatch: async (_environmentId: string, method: string, params: unknown) => {
        sent.push({ method, params });
        return answer;
      },
    },
  } as unknown as Parameters<typeof answerPrompt>[0];
  return { runtime, sent };
};

const target = { environmentId: "env-a", sessionId: "s-1", promptId: "p-1" };
const failed = (commandId: string | null, code: string): Answer => ({ ok: false, commandId, error: { code, message: `It failed: ${code}.` } });

describe("answerPrompt", () => {
  it("sends the answer as permissions.prompts.answer with the prompt's session", async () => {
    const { runtime, sent } = answering({ ok: true, commandId: "c-1", receipt: { status: "accepted", sequence: 1, changed: true } });
    expect(await answerPrompt(runtime, target, { decision: "allow", remember: "session" })).toEqual({ ok: true });
    expect(sent).toEqual([{ method: "permissions.prompts.answer", params: { promptId: "p-1", sessionId: "s-1", decision: "allow", remember: "session" } }]);
  });

  it("says a failure the runtime raised a notice for, marked so: the environment's rejection, or the outbox's drop", async () => {
    for (const code of ["conflict", "not_found", "invalid_params", "expired", "unconfirmed", "internal"]) {
      expect(await answerPrompt(answering(failed("c-1", code)).runtime, target, { decision: "deny" }), code).toEqual({
        ok: false,
        line: `Not answered: It failed: ${code}.`,
        noticed: true,
      });
    }
  });

  it("says a failure the runtime raised no notice for, marked so", async () => {
    expect(await answerPrompt(answering(failed(null, "unreachable")).runtime, target, { decision: "deny" })).toEqual({
      ok: false,
      line: "Not answered: It failed: unreachable.",
      noticed: false,
    });
    expect(await answerPrompt(answering(failed(null, "scope")).runtime, target, { decision: "deny" })).toEqual({ ok: false, line: "Not answered: It failed: scope.", noticed: false });
    for (const code of ["unreachable", "closed", "forgotten"]) {
      expect(await answerPrompt(answering(failed("c-1", code)).runtime, target, { decision: "deny" }), code).toEqual({
        ok: false,
        line: `Not answered: It failed: ${code}.`,
        noticed: false,
      });
    }
  });
});
