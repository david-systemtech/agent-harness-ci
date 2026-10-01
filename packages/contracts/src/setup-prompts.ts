import { z } from "zod";
import { sharedManifestYaml } from "./bank-templates.js";
import { BANK_CAPS, BANK_KINDS, BANK_LAYOUT, BANK_VALIDATOR, MEMORY_TYPES, ORIENTATION_CAPS, REVIEWED_CLASSES, SCOPE_FILES, TRIGGER_WORDS } from "./banks.js";

/**
 * The prompts of the LLM steps (ADR 0019; the Set up specification, "The
 * LLM step and minted sessions"; #584). An LLM step is a step whose
 * artefact has to be authored rather than filled in: it names its prompt
 * in the registry's `llm`, and `setup.mint` starts a minted session with
 * it. A prompt has two variants, `first`, which authors the artefact, and
 * `revise`, which revises the one there. The environment renders it from
 * live facts (a bank's name, kind, entities, scope folders and orientation
 * caps), which the prompt parses before it renders, and it carries the
 * name and version of the validator the artefact must satisfy, so the
 * prompt and the validator it was written for ship together, never fetched
 * apart from it.
 */

export const PROMPT_VARIANTS = ["first", "revise"] as const;
export const PromptVariant = z.enum(PROMPT_VARIANTS).meta({
  description: "Which of an LLM step's prompts a minted session starts with: first, which authors the step's artefact, or revise, which revises the one there.",
});
export type PromptVariant = z.infer<typeof PromptVariant>;

/** The validator an LLM step's artefact must satisfy, by name and version: a prompt is written for one version of it. */
export interface PromptValidator {
  readonly name: string;
  readonly version: number;
}

/** A prompt rendered for a minted session: which prompt and variant, its text, and the validator its artefact must satisfy. */
export interface RenderedPrompt {
  readonly prompt: string;
  readonly variant: PromptVariant;
  readonly text: string;
  readonly validator: PromptValidator;
}

/** One LLM step's prompt, as the environment renders it: by its id, from facts it parses itself. */
export interface StepPrompt {
  /** What a step's `llm` names it by. */
  readonly id: string;
  readonly validator: PromptValidator;
  /** Facts it renders from, for the contract test. */
  readonly example: unknown;
  /** Renders `variant` from `facts`; throws when the facts are not the ones it renders from. */
  render(variant: PromptVariant, facts: unknown): RenderedPrompt;
}

/** What a prompt is written as: its id and validator, the facts it renders from, each variant over them, and an example of them. */
export interface StepPromptDefinition<Facts> {
  readonly id: string;
  readonly validator: PromptValidator;
  readonly facts: z.ZodType<Facts>;
  readonly first: (facts: Facts) => string;
  readonly revise: (facts: Facts) => string;
  readonly example: NoInfer<Facts>;
}

/** A step's prompt from its definition: rendering parses the facts it is given before either variant reads them. */
export const stepPrompt = <Facts>(definition: StepPromptDefinition<Facts>): StepPrompt => ({
  id: definition.id,
  validator: definition.validator,
  example: definition.example,
  render: (variant, facts) => ({
    prompt: definition.id,
    variant,
    text: definition[variant](definition.facts.parse(facts)),
    validator: definition.validator,
  }),
});

/** The facts the describe prompt renders from: the bank's name and kind, the entities its `BANK.md` names with their aliases, and its scope folders. */
const DescribeBankFacts = z.object({
  name: z.string().min(1),
  kind: z.enum(BANK_KINDS),
  entities: z.array(z.object({ name: z.string().min(1), aliases: z.array(z.string().min(1)) })),
  scopes: z.array(z.string().min(1)),
});
type DescribeBankFacts = z.infer<typeof DescribeBankFacts>;

/** "a", "a and b", "a, b and c", or with "or". */
const listed = (items: readonly string[], conjunction = "and"): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`);

/** The bank as both variants name it: "david-memory, a personal bank". */
const bankLine = ({ name, kind }: DescribeBankFacts): string => `${name}, a ${kind} bank`;

/**
 * The folder the bank's orientation memories live in (banks spec, "BANK.md
 * and the folders"; ADR 0034, ADR 0037): a personal bank's
 * `projects/personal/memory-bank/`, a team bank's `projects/<first org>/bank/`,
 * the first org read from its first scope folder.
 */
const homeFolder = ({ kind, scopes }: DescribeBankFacts): string => {
  if (kind === "personal") return "projects/personal/memory-bank/";
  const org = /^projects\/([^/]+)\//.exec(scopes[0] ?? "")?.[1];
  return org === undefined ? "projects/<its first org>/bank/" : `projects/${org}/bank/`;
};

/**
 * What `BANK.md` must hold to pass the validator, as a list for the model: a
 * team bank's owners too, and the keys every bank shares as the templates
 * write them, which a `BANK.md` written from nothing copies (#1078).
 */
const manifestRules = (facts: DescribeBankFacts): string => {
  const entities = facts.entities.map(({ name, aliases }) => (aliases.length === 0 ? name : `${name} (${aliases.join(", ")})`));
  return [
    `- name: ${facts.name}, the bank's name: a lower-case slug of 1 to ${BANK_CAPS.bankName} characters, letters, digits and single hyphens between them.`,
    `- kind: ${facts.kind}.`,
    `- purpose: one line of at most ${BANK_CAPS.purpose} characters saying what the bank is for.`,
    `- entities: what the bank holds facts about, at least one, each with its name, its aliases (at least one), and folder: naming the scope folder a match expands, relative to projects/ (org/project/ for projects/org/project/), a folder that has its folder file. ${entities.length === 0 ? "It names no entity yet." : `It names ${listed(entities)} so far.`}`,
    `- orientation: at most ${ORIENTATION_CAPS.names} memory names every session always sees, each memory at most ${ORIENTATION_CAPS.bytesEach} bytes and ${ORIENTATION_CAPS.bytesInAll.toLocaleString("en-US")} bytes in all, kept in the bank's home folder, ${homeFolder(facts)}.`,
    ...(facts.kind === "team" ? ["- owners: the forge logins that review the bank's reviewed changes, at least one."] : []),
    `- memories, docs and write: as below when you write BANK.md from nothing. ${listed(Object.keys(BANK_LAYOUT))} are every bank's one folder structure, and reviewed names the classes of change that always wait for an owner's review, every one of ${listed(REVIEWED_CLASSES)}. land is commit instead for a bank that lives on this machine only, with no forge, and memories is review when the bank's memories wait for an owner too.`,
    "```yaml",
    sharedManifestYaml("pull-request"),
    "```",
  ].join("\n");
};

/**
 * What an orientation memory and the home folder it is kept in need to pass
 * the validator (#1106): the memory's path and frontmatter, and the folder
 * files of the home folder and its org, which a bank not made from a
 * template lacks.
 */
const homeRules = (facts: DescribeBankFacts): string => {
  const home = homeFolder(facts);
  const org = home.replace(/[^/]+\/$/, "");
  return [
    `Write each orientation memory as ${home}memories/<name>.md, its frontmatter holding name: (the file's name, a lower-case slug of at most ${BANK_CAPS.memoryName} characters), description: (${BANK_CAPS.description.min} to ${BANK_CAPS.description.max} characters saying when a run needs it, opening with ${listed(TRIGGER_WORDS, "or")}) and metadata: with type: (one of ${listed(MEMORY_TYPES, "or")}).`,
    `The home folder and its org each keep their folder file; write the ones the bank lacks: ${org}${SCOPE_FILES.org} with line: (the org's one-liner, at most ${BANK_CAPS.line} characters), and ${home}${SCOPE_FILES.project} with line: (the folder's one-liner, at most ${BANK_CAPS.line} characters), topics: ({} for none) and repos: ([] for none).`,
  ].join(" ");
};

/** The bank's scope folders, and the shape every folder takes (ADR 0037). */
const scopeLine = ({ scopes }: DescribeBankFacts): string =>
  `${scopes.length === 0 ? "It has no scope folder yet." : `Its scope folders are ${listed(scopes)}.`} Folders follow projects/{org}/{project}/{area}/, the area optional.`;

/** What the person is asked before a BANK.md is written from nothing: by `first`, and by `revise` on a main without one (the manifest check's Revise). */
const ASK_PURPOSE = "what the bank is for and what it holds facts about";

const WORKTREE = "You work in a worktree of the bank on a branch of its own, so nothing reaches the bank's main until your change is reviewed and landed.";

const VALIDATE = `When the bank holds .agent-harness/validate.mjs, run it with node before you commit.`;

const LANDING =
  "Commit on this branch, then land it through the bank's review path: push the branch and open a pull request against main. BANK.md is a reviewed change, so the pull request waits for an owner's review.";

/**
 * The Memory bank step's describe prompt (ADR 0019, ADR 0035, ADR 0037;
 * #586): `first` writes a bank's `BANK.md` with the person, `revise`
 * revises the one its main holds, or writes one when main has none (the
 * manifest check offers Revise for both), each in the minted session's worktree of
 * the bank and landed through the bank's review path, so that it passes the
 * bank validator at the version the prompt carries.
 */
const describeBank = stepPrompt({
  id: "describe-bank",
  validator: BANK_VALIDATOR,
  facts: DescribeBankFacts,
  first: (facts) =>
    [
      `Describe the memory bank ${bankLine(facts)}, by writing its BANK.md.`,
      WORKTREE,
      `Ask me ${ASK_PURPOSE} before you write. Then write BANK.md at the root of this worktree so it passes the bank validator, version ${BANK_VALIDATOR.version}:\n${manifestRules(facts)}`,
      homeRules(facts),
      scopeLine(facts),
      `${VALIDATE} ${LANDING}`,
    ].join("\n\n"),
  revise: (facts) =>
    [
      `Revise BANK.md of the memory bank ${bankLine(facts)}.`,
      `${WORKTREE} It holds BANK.md as the bank's main has it: read it and the bank's folders, then ask me what has changed before you edit. If main has no BANK.md, ask me ${ASK_PURPOSE}, then write BANK.md at the root of this worktree.`,
      `Leave BANK.md passing the bank validator, version ${BANK_VALIDATOR.version}:\n${manifestRules(facts)}`,
      homeRules(facts),
      scopeLine(facts),
      `${VALIDATE} ${LANDING}`,
    ].join("\n\n"),
  example: {
    name: "david-memory",
    kind: "personal",
    entities: [{ name: "Homelab", aliases: ["home lab"] }],
    scopes: ["projects/personal/agent-harness/"],
  },
});

/**
 * Every LLM step's prompt, by the id its entry's `llm` names: in milestone 1
 * the Memory bank step's describe prompt alone (#586).
 */
export const STEP_PROMPTS: readonly StepPrompt[] = [describeBank];
