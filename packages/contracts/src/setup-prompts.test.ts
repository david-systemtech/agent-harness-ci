import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BANK_VALIDATOR, ORIENTATION_CAPS, PROMPT_VARIANTS, STEP_PROMPTS, STEP_REGISTRY, stepPrompt, type Step, type StepPrompt } from "./index.js";

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

/** The Memory bank step's describe prompt, which its entry names. */
const describeBank = STEP_PROMPTS.find((prompt) => prompt.id === "describe-bank") as StepPrompt;

/** A personal bank as the step renders it: its name and kind, an entity with aliases, and two scope folders. */
const personal = {
  name: "david-memory",
  kind: "personal",
  entities: [{ name: "Homelab", aliases: ["home lab", "SYSTEM-SERVER"] }],
  scopes: ["projects/personal/agent-harness/", "projects/personal/homelab/"],
};

/** A team bank with no entity yet and one scope folder. */
const team = { name: "brandsolidate", kind: "team", entities: [], scopes: ["projects/brandsolidate/cool-jams/"] };

describe("the Memory bank step's describe prompt (#586)", () => {
  it("is the bank validator's, at version 1, whose orientation caps are ADR 0013's five names, 600 bytes each and 1,500 in all", () => {
    expect(describeBank.validator).toEqual({ name: "bank-validator", version: 1 });
    expect(BANK_VALIDATOR).toEqual({ name: "bank-validator", version: 1 });
    expect(ORIENTATION_CAPS).toEqual({ names: 5, bytesEach: 600, bytesInAll: 1_500 });
  });

  it("renders first from the bank's name, kind, entities and scope folders, with the orientation caps and the validator's version, asking for BANK.md landed through the review path from the worktree", () => {
    const rendered = describeBank.render("first", personal);
    expect(rendered).toMatchObject({ prompt: "describe-bank", variant: "first", validator: { name: "bank-validator", version: 1 } });
    for (const part of [
      "david-memory, a personal bank",
      "BANK.md",
      "the bank validator, version 1",
      "Homelab (home lab, SYSTEM-SERVER)",
      "projects/personal/agent-harness/ and projects/personal/homelab/",
      "at most 5 memory names",
      "at most 600 bytes",
      "1,500 bytes in all",
      "projects/personal/memory-bank/",
      "worktree",
      "pull request",
    ]) {
      expect(rendered.text, part).toContain(part);
    }
    expect(rendered.text).not.toContain("owners");
  });

  it("asks a team bank for its owners and puts its orientation in its first org's bank folder, and says when it names no entity yet", () => {
    const { text } = describeBank.render("first", team);
    for (const part of ["brandsolidate, a team bank", "owners", "projects/brandsolidate/bank/", "projects/brandsolidate/cool-jams/", "names no entity yet"]) expect(text, part).toContain(part);
  });

  it("renders revise from the same facts, asking for the BANK.md main holds to be revised and kept valid", () => {
    const rendered = describeBank.render("revise", personal);
    expect(rendered).toMatchObject({ prompt: "describe-bank", variant: "revise", validator: { name: "bank-validator", version: 1 } });
    for (const part of ["Revise", "david-memory, a personal bank", "the bank validator, version 1", "Homelab (home lab, SYSTEM-SERVER)", "projects/personal/homelab/", "pull request"]) {
      expect(rendered.text, part).toContain(part);
    }
    expect(rendered.text).not.toBe(describeBank.render("first", personal).text);
  });

  it("renders revise for a bank whose main has no BANK.md too, the manifest check's Revise, asking what the bank is for before writing one", () => {
    const { text } = describeBank.render("revise", personal);
    expect(text).toContain("If main has no BANK.md, ask me what the bank is for and what it holds facts about, then write BANK.md at the root of this worktree.");
    expect(text).not.toContain("Keep BANK.md");
  });

  it("refuses facts without the bank's kind, or of a kind no bank has", () => {
    expect(() => describeBank.render("first", { ...personal, kind: undefined })).toThrow();
    expect(() => describeBank.render("first", { ...personal, kind: "shared" })).toThrow();
  });
});
