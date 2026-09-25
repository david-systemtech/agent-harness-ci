import { MODES, PROMPT_KINDS } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { BYPASS_DENIAL, UNATTENDED_ANSWER, UNATTENDED_DENIAL, autoAnswer } from "./auto-answer.js";

/**
 * The broker's automatic rules (#131; permissions spec, "Attended and
 * unattended runs; the unattended default"), pure: the unattended rule for
 * every kind of prompt, the bypass rule for a residual permission prompt,
 * and nothing for anything a person may still answer.
 */

describe("autoAnswer", () => {
  it("denies every prompt of an unattended run at once, in every mode, with the message the model reads; a question gets the unattended answer", () => {
    expect(UNATTENDED_DENIAL).toBe("Denied: nobody is present to approve this. Continue without it and say what you could not do.");
    expect(UNATTENDED_ANSWER).toBe("nobody is present; proceed with your best judgement");
    for (const mode of MODES) {
      for (const kind of PROMPT_KINDS) {
        const message = kind === "question" ? UNATTENDED_ANSWER : UNATTENDED_DENIAL;
        expect(autoAnswer({ kind, attended: false, mode }), `${kind} in ${mode}`).toEqual({ auto: "unattended", decision: { decision: "deny", message } });
      }
    }
  });

  it("denies a residual permission prompt of an attended run in bypassPermissions, and leaves the other kinds to a person", () => {
    expect(autoAnswer({ kind: "permission", attended: true, mode: "bypassPermissions" })).toEqual({ auto: "bypass", decision: { decision: "deny", message: BYPASS_DENIAL } });
    expect(BYPASS_DENIAL).toMatch(/^Denied: .*Continue without it and say what you could not do\.$/);
    for (const kind of ["denylist", "question", "plan"] as const) expect(autoAnswer({ kind, attended: true, mode: "bypassPermissions" }), kind).toBeNull();
  });

  it("leaves every prompt of an attended run below bypassPermissions to a person", () => {
    for (const mode of ["plan", "acceptEdits", "auto"] as const) {
      for (const kind of PROMPT_KINDS) expect(autoAnswer({ kind, attended: true, mode }), `${kind} in ${mode}`).toBeNull();
    }
  });
});
