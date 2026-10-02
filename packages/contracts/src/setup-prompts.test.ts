import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { z } from "zod";
import { validateBank } from "./bank-validator.js";
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

/**
 * The BANK.md a model writes from nothing to what a describe prompt's `text`
 * asks for (#1078): the name and kind it gives, the keys its YAML block shows
 * exactly as shown, and the purpose, entities, orientation and a team's owners
 * filled in as its list asks.
 */
const writtenTo = (text: string, orientation: readonly string[] = []): string => {
  const name = /^- name: ([^,\s]+),/m.exec(text)?.[1];
  const kind = /^- kind: ([a-z]+)\./m.exec(text)?.[1];
  const shown = /^```yaml\n([\s\S]*?)\n```$/m.exec(text)?.[1];
  expect({ name, kind, shown }, "the prompt gives the name and kind and shows the shared keys").toEqual({ name: expect.any(String), kind: expect.any(String), shown: expect.any(String) });
  const asked = {
    name,
    kind,
    purpose: "What the bank is for, in one line.",
    entities: [{ name: "Homelab", aliases: ["home lab"] }],
    orientation,
    ...(kind === "team" && { owners: ["david"] }),
  };
  return `---\n${stringify(asked)}${shown}\n---\n\n# How agents use this bank\n`;
};

/**
 * The orientation memory `name` and the folder files a model writes beside
 * that BANK.md to what a describe prompt's `text` asks for (#1106): the
 * memory at the path the prompt gives, with the frontmatter it names, and
 * the home folder's and its org's folder files at the paths it gives.
 */
const homeWrittenTo = (text: string, name: string): Record<string, string> => {
  const memories = /(\S+\/memories\/)<name>\.md/.exec(text)?.[1];
  const org = /(\S+\/)ORG\.md/.exec(text)?.[1];
  const project = /(\S+\/)PROJECT\.md/.exec(text)?.[1];
  expect({ memories, org, project }, "the prompt gives where the memory and the folder files go").toEqual({ memories: expect.any(String), org: expect.any(String), project: expect.any(String) });
  const file = (frontmatter: Record<string, unknown>, body = ""): string => `---\n${stringify(frontmatter)}---\n${body}`;
  return {
    [`${memories}${name}.md`]: file({ name, description: "When a run needs to know where the bank keeps its secrets - the paths, never the values", metadata: { type: "reference" } }, "The keys live in the key manager, by path.\n"),
    [`${org}ORG.md`]: file({ line: "The org's own work" }),
    [`${project}PROJECT.md`]: file({ line: "This bank's own facts", topics: {}, repos: [] }),
  };
};

describe("the Memory bank step's describe prompt (#586)", () => {
  it("asks a local-only describe session to commit for environment-owned landing", () => {
    for (const variant of ["first", "revise"] as const) {
      const { text } = describeBank.render(variant, { ...personal, localOnly: true });
      expect(text).toContain("Commit on this branch. The environment lands the committed describe artefacts on main through the BankService");
      expect(text).not.toContain("push the branch");
    }
  });

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

  it("states, in both variants, the name rule and the keys every bank shares, with the classes that always wait for review (#1078)", () => {
    for (const variant of PROMPT_VARIANTS) {
      const { text } = describeBank.render(variant, personal);
      for (const part of [
        "- name: david-memory,",
        "a lower-case slug of 1 to 40 characters",
        "folder: naming the scope folder a match expands, relative to projects/",
        "projects/**/memories/**/*.md",
        "projects/{org}/{project}[/{area}]/",
        "projects/{org}/{project}[/{area}]/memories/[{topic}/]{name}.md",
        "reference/**/*.md",
        "pull-request",
        "commit",
        "orientation, decisions, status and manifest",
        "the bank validator, version 1",
      ]) {
        expect(text, `${variant}: ${part}`).toContain(part);
      }
    }
  });

  it("asks, in both variants and for both kinds, for a BANK.md that passes the validator with no finding when written from nothing (#1078)", () => {
    for (const facts of [personal, team]) {
      for (const variant of PROMPT_VARIANTS) {
        const { text } = describeBank.render(variant, facts);
        expect(validateBank({ files: { "BANK.md": writtenTo(text) } }), `${facts.kind}, ${variant}`).toEqual({ validator: { name: "bank-validator", version: 1 }, valid: true, findings: [] });
      }
    }
  });

  it("says, in both variants, what an orientation memory and its home folder hold (#1106)", () => {
    for (const variant of PROMPT_VARIANTS) {
      const { text } = describeBank.render(variant, team);
      for (const part of [
        "projects/brandsolidate/bank/memories/<name>.md",
        "a lower-case slug of at most 60 characters",
        "60 to 160 characters",
        "Before, When, After, While, If, Where, How, What, Which or Why",
        "one of user, feedback, project or reference",
        "projects/brandsolidate/ORG.md with line:",
        "projects/brandsolidate/bank/PROJECT.md with line:",
        "at most 100 characters",
        "topics: ({} for none)",
        "a folder that has its folder file",
      ]) {
        expect(text, `${variant}: ${part}`).toContain(part);
      }
    }
  });

  it("asks, in both variants and for both kinds, for an orientation memory and a home folder that pass the validator with no finding beside that BANK.md (#1106)", () => {
    for (const facts of [personal, team]) {
      for (const variant of PROMPT_VARIANTS) {
        const { text } = describeBank.render(variant, facts);
        const files = { "BANK.md": writtenTo(text, ["secrets-layout"]), ...homeWrittenTo(text, "secrets-layout") };
        expect(validateBank({ files }), `${facts.kind}, ${variant}`).toEqual({ validator: { name: "bank-validator", version: 1 }, valid: true, findings: [] });
      }
    }
  });

  it("refuses facts without the bank's kind, or of a kind no bank has", () => {
    expect(() => describeBank.render("first", { ...personal, kind: undefined })).toThrow();
    expect(() => describeBank.render("first", { ...personal, kind: "shared" })).toThrow();
  });
});
