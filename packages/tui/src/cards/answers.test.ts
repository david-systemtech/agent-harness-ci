import type { DispatchAnswer, Runtime } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { answerPrompt } from "./answers.js";

/**
 * What an answer's failure says (`cards/answers.ts`): nothing more where the
 * runtime's outbox has raised its one notice (a rejection, a drop), one line
 * where it raises none (refused at dispatch, the socket gone before its turn,
 * the runtime closed, the environment removed).
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
  } as unknown as Runtime;
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

  it("says nothing more where the runtime raised a notice: the environment's rejection, or the outbox's drop", async () => {
    for (const code of ["conflict", "not_found", "invalid_params", "expired", "unconfirmed", "internal"]) {
      expect(await answerPrompt(answering(failed("c-1", code)).runtime, target, { decision: "deny" }), code).toEqual({ ok: false, line: undefined });
    }
  });

  it("says a failure in one line where the runtime raised no notice", async () => {
    expect(await answerPrompt(answering(failed(null, "unreachable")).runtime, target, { decision: "deny" })).toEqual({ ok: false, line: "Not answered: It failed: unreachable." });
    expect(await answerPrompt(answering(failed(null, "scope")).runtime, target, { decision: "deny" })).toEqual({ ok: false, line: "Not answered: It failed: scope." });
    for (const code of ["unreachable", "closed", "forgotten"]) {
      expect(await answerPrompt(answering(failed("c-1", code)).runtime, target, { decision: "deny" }), code).toEqual({ ok: false, line: `Not answered: It failed: ${code}.` });
    }
  });
});
