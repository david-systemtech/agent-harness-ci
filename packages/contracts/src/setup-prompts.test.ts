import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROMPT_VARIANTS, STEP_PROMPTS, STEP_REGISTRY, stepPrompt, type Step } from "./index.js";

/**
 * The prompts of the LLM steps (ADR 0019; the Set up specification, "The
 * LLM step and minted sessions"; #584): one per LLM step, with a `first`
 * and a `revise` variant, each rendered from the live facts it is given
 * and carrying the version of the validator its artefact must satisfy.
 * Every registered step that names a prompt in `llm` renders both variants
 * from its prompt's example facts.
 */

/** A prompt of the test's own: a note named by its facts, checked by a validator at version 3. */
const notePrompt = stepPrompt({
  id: "test-note",
  validator: { name: "note-validator", version: 3 },
  facts: z.object({ name: z.string(), folders: z.array(z.string()) }),
  first: ({ name, folders }) => `Write the note ${name} covering ${folders.join(" and ")}.`,
  revise: ({ name }) => `Revise the note ${name}.`,
  example: { name: "example", folders: ["work"] },
});

describe("a step's prompt", () => {
  it("has a first and a revise variant", () => {
    expect(PROMPT_VARIANTS).toEqual(["first", "revise"]);
  });

  it("renders each variant from the facts it is given, carrying the version of the validator it must satisfy", () => {
    expect(notePrompt.render("first", { name: "david-memory", folders: ["personal", "agent-harness"] })).toEqual({
      prompt: "test-note",
      variant: "first",
      text: "Write the note david-memory covering personal and agent-harness.",
      validator: { name: "note-validator", version: 3 },
    });
    expect(notePrompt.render("revise", { name: "team-memory", folders: [] })).toEqual({
      prompt: "test-note",
      variant: "revise",
      text: "Revise the note team-memory.",
      validator: { name: "note-validator", version: 3 },
    });
  });

  it("refuses facts that are not the ones it renders from", () => {
    expect(() => notePrompt.render("first", { name: "david-memory" })).toThrow();
  });
});

describe("the prompts of the registered LLM steps", () => {
  it("are each named once", () => {
    const ids = STEP_PROMPTS.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("render the first and revise prompts of every step that names one in llm, from its example facts", () => {
    const steps: readonly Step[] = STEP_REGISTRY;
    for (const step of steps.filter((entry) => entry.llm !== undefined)) {
      const prompt = STEP_PROMPTS.find((entry) => entry.id === step.llm);
      expect(prompt, step.id).toBeDefined();
      for (const variant of PROMPT_VARIANTS) {
        const rendered = prompt?.render(variant, prompt.example);
        expect(rendered?.text.trim(), `${step.id} ${variant}`).not.toBe("");
        expect(rendered?.validator, `${step.id} ${variant}`).toEqual(prompt?.validator);
      }
    }
  });
});
