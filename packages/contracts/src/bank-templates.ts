import { BANK_LAYOUT, REVIEWED_CLASSES, SCOPE_FILES } from "./banks.js";
import { PRODUCT_NAME } from "./product.js";

/**
 * The two shipped bank templates (banks spec, "BANK.md and the folders";
 * ADR 0034, rewritten for ADR 0037's org, project and area; ADR 0035), as
 * the files a bank's first commit holds: `BANK.md`, the folder skeleton
 * with the bank's home folder for orientation, and the README, the body
 * rendered with nothing left to fill. Rendering is deterministic: the same
 * facts give the same files, and a rendered bank passes the validator with
 * no finding. Orientation starts empty: the describe conversation writes
 * its memories into the home folder and lists them (ADR 0019, ADR 0035).
 * The vendored validator and its workflow are added beside these by the
 * BankService (`bankValidatorWorkflow`).
 */

/** A bank's repository on its forge: the forge as a person names it and the repository's owner and name. */
export interface BankRepository {
  /** `GitHub`, `Forgejo`, `Gitea`. */
  readonly forge: string;
  /** `owner/name`. */
  readonly path: string;
}

/** Where the bank's secrets live: the key manager's product and the prefix under it. */
export interface BankKeyManager {
  readonly product: string;
  readonly path: string;
}

/** What the wizard knows when it writes a personal bank (ADR 0035). */
export interface PersonalBankFacts {
  /** The bank's name, its repository's name. */
  readonly name: string;
  /** The person: their name and their forge login, the first entity. */
  readonly person: { readonly name: string; readonly login: string };
  /** The first org, "what do you call your own work", preset `personal`. */
  readonly org: string;
  /** The first project, preset to the primary repository's name. */
  readonly project: string;
  /** The bank's repository, whose tracker takes its follow-ups; null for a local-only bank, which commits on its main and keeps them in `issues/`. */
  readonly repository: BankRepository | null;
  /** None when the environment has no key manager (ADR 0011). */
  readonly keyManager: BankKeyManager | null;
}

/** What the wizard knows when it writes a team bank (ADR 0037). */
export interface TeamBankFacts {
  readonly name: string;
  /** The team's name and the org folder it becomes. */
  readonly team: { readonly name: string; readonly org: string };
  /** The first projects, each an entity and a folder of its own. */
  readonly projects: readonly { readonly name: string; readonly folder: string }[];
  /** The forge logins that review the bank's reviewed changes, the creator first. */
  readonly owners: readonly string[];
  /** A team bank always lives on a forge. */
  readonly repository: BankRepository;
  readonly keyManager: BankKeyManager | null;
}

/** A bank's files by path, as its first commit holds them. */
export type BankTemplateFiles = Readonly<Record<string, string>>;

/** The personal bank's org and home folder for orientation (ADR 0034, ADR 0035). */
const PERSONAL_HOME = { org: "personal", project: "memory-bank" } as const;

/** A team bank's home folder for orientation, under its first org (ADR 0037). */
const TEAM_HOME = "bank";

type Yaml = string | readonly Yaml[] | { readonly [key: string]: Yaml };

/** A string as YAML reads it back: plain when it is a word YAML takes as a string, quoted otherwise. */
const scalar = (text: string): string => (/^[a-z][a-z0-9-]*$/.test(text) && !["null", "true", "false"].includes(text) ? text : JSON.stringify(text));

/** `value` as block YAML lines at `indent`: mappings and lists of mappings in block style, lists of strings and empty collections in flow style. */
const yamlLines = (value: Yaml, indent = ""): string[] => {
  if (typeof value === "string") return [`${indent}${scalar(value)}`];
  if (Array.isArray(value)) {
    const list = value as readonly Yaml[];
    return list.flatMap((item) => {
      const [first = "", ...rest] = yamlLines(item, `${indent}  `);
      return [`${indent}- ${first.trimStart()}`, ...rest];
    });
  }
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === "string") return [`${indent}${key}: ${scalar(item)}`];
    if (Array.isArray(item) && item.every((each) => typeof each === "string")) return [`${indent}${key}: [${(item as readonly string[]).map(scalar).join(", ")}]`];
    if (!Array.isArray(item) && Object.keys(item).length === 0) return [`${indent}${key}: {}`];
    return [`${indent}${key}:`, ...yamlLines(item, `${indent}  `)];
  });
};

const withFrontmatter = (frontmatter: Yaml, body: string): string => `---\n${yamlLines(frontmatter).join("\n")}\n---\n${body}`;

/** A folder file: `ORG.md` with its line, or a project's `PROJECT.md` with its line, no topics yet and no repositories. */
const folderFile = (level: "org" | "project", title: string, line: string): string =>
  withFrontmatter(level === "org" ? { line } : { line, topics: {}, repos: [] }, `\n# ${title}\n`);

/** The keys every bank's manifest shares: the layout, the documents and the write rule, memories merging on their own (ADR 0035). */
const sharedKeys = (land: "pull-request" | "commit"): { readonly [key: string]: Yaml } => ({
  memories: { glob: BANK_LAYOUT.glob, scope: BANK_LAYOUT.scope, schema: BANK_LAYOUT.schema },
  docs: { globs: ["projects/**/{PROJECT,AREA,HANDOFF,PLAN}.md", "reference/**/*.md"] },
  write: { place: BANK_LAYOUT.place, land, merge: { memories: "auto", reviewed: [...REVIEWED_CLASSES] } },
});

/** The README a bank's first commit holds: its name, its purpose and the template's body. */
const readme = (name: string, purpose: string, body: string): string => `# ${name}\n\n${purpose}\n${body}`;

const secretsLine = (keyManager: BankKeyManager | null, scope: string): string =>
  keyManager === null
    ? "Keys, tokens and passwords live in a key manager, never here; a memory names where one is kept, never the value."
    : `Keys, tokens and passwords live in ${keyManager.product} under ${keyManager.path}, ${scope}; a memory names the path, never the value.`;

/** The rules every bank's body carries, after its own opening: reading, scoping, writing and landing. */
const sharedRules = (bank: string, home: string, scopeFile: string): string =>
  [
    `- **Start from the index.** Every run begins with this bank's line, its orientation facts and one breadcrumb per project or area holding memories, grouped under each org: \`${bank}:<org>/<project>/ (count) — what it holds\`. Open a folder with \`memory_read ${bank}:<org>/<project>/\`: it returns the folder's memory lines and topics, the same text the index would show. Search with \`memory_search\`, narrowed by scope; it says how many matches there were. Copy pointers verbatim; never compose one.`,
    `- **Every memory belongs to a project or an area.** Folders are \`projects/<org>/<project>/\`, with an optional \`<area>/\` inside a project; memories live in its \`memories/\`. Draft with \`memory_draft\`, naming this bank and the scope by org, project and area, then \`memory_promote\`. Never invent a folder: a new org needs its \`ORG.md\`, a new project its \`PROJECT.md\`, a new area its \`AREA.md\`, each with \`line:\`, written on a branch first.`,
    "- **One fact per memory, and the description is the hook.** A run finds a memory by its description: write it at 60 to 160 characters, opening with a trigger word (Before, When, If, How), and unlike every other description in its folder. The body stays under 6,000 characters.",
    `- **A full folder gets topics, not a longer list.** A folder's index holds at most 40 lines. The draft that would make the 41st is refused with the folder's topics: file it under one, or declare a new topic in the folder's ${scopeFile} \`topics:\` map, on a branch. A memory moved into a topic keeps its name and every \`[[link]]\` to it.`,
    `- **Orientation is short pointers.** The orientation list names at most five memories, kept in \`${home}\`, each at most 600 bytes and 1,500 bytes in all, pointing at the longer memories rather than restating them. The list is in this file, so changing it is always reviewed.`,
    "- **Point, do not restate.** A memory names the memory, decision or plan that holds a fact rather than copying it. Absolute dates only.",
    "- **Say what is verified.** Every claim carries how it is known: measured (when, and with what), reported (by whom), or a hypothesis.",
  ].join("\n");

const personalBody = (facts: PersonalBankFacts, home: string): string => {
  const first = facts.person.name.split(/\s+/)[0] ?? facts.person.name;
  const landing =
    facts.repository === null
      ? `This bank lives on this machine only: a change lands as a commit on its main. Follow-ups are files in \`issues/\`, each with the evidence that found it and a "done when" checklist, until the bank is published to a forge.`
      : `\`memory_promote\` opens the pull request on ${facts.repository.forge}, merges it when this bank allows and checks the file is on main. Memory pull requests merge on their own; one that touches orientation, a \`decisions/\` folder, a status or this file waits for ${first}. Follow-ups are issues in ${facts.repository.path} on ${facts.repository.forge}, each with the evidence that found it and a "done when" checklist: a memory says what is true, an issue says what is owed.`;
  return [
    "",
    "# How agents use this bank",
    "",
    `This is ${facts.person.name}'s own memory, private to them: their machines, projects and companies. Nothing in it is shared with a team, and a team's facts go to that team's bank; the run's instructions say which bank takes which names.`,
    "",
    sharedRules(facts.name, home, "`PROJECT.md` or `AREA.md`"),
    `- **Land what you promote.** ${landing}`,
    `- **Secrets never enter this bank.** ${secretsLine(facts.keyManager, "one entry per project")} A key given in the chat goes into the key manager, never into a file or a memory.`,
    "",
  ].join("\n");
};

/** The personal bank's first commit (ADR 0035, ADR 0037): `BANK.md`, the README, the person's first org and project, and the home folder. */
export const renderPersonalBank = (facts: PersonalBankFacts): BankTemplateFiles => {
  const home = `projects/${PERSONAL_HOME.org}/${PERSONAL_HOME.project}/`;
  const first = `projects/${facts.org}/${facts.project}/`;
  const purpose = `${facts.person.name}'s memory: their own machines, projects and companies. A team's facts go to that team's bank.`;
  const body = personalBody(facts, home);
  const manifest = withFrontmatter(
    {
      name: facts.name,
      kind: "personal",
      purpose,
      entities: [{ name: facts.person.name, aliases: [facts.person.login] }],
      orientation: [],
      ...sharedKeys(facts.repository === null ? "commit" : "pull-request"),
    },
    body,
  );
  return {
    "BANK.md": manifest,
    "README.md": readme(facts.name, purpose, body),
    [`projects/${PERSONAL_HOME.org}/${SCOPE_FILES.org}`]: folderFile("org", "Personal", `${facts.person.name}'s own work`),
    [`${home}${SCOPE_FILES.project}`]: folderFile("project", "The memory bank", "This bank's own facts: where secrets live, the machines, where work is tracked"),
    ...(facts.org !== PERSONAL_HOME.org && { [`projects/${facts.org}/${SCOPE_FILES.org}`]: folderFile("org", facts.org, `${facts.person.name}'s ${facts.org} work`) }),
    // A first project at the home folder is the home folder: its file stays the home's.
    ...(first !== home && { [`${first}${SCOPE_FILES.project}`]: folderFile("project", facts.project, `The ${facts.project} project`) }),
  };
};

const teamBody = (facts: TeamBankFacts, home: string): string =>
  [
    "",
    "# How agents use this bank",
    "",
    `This bank is shared. Everyone on the ${facts.team.name} team reads it, and every run of every teammate's agent may load it: write each line as if the whole team will read it tomorrow. It holds the team's work and nothing else.`,
    "",
    "- **No personal or private facts.** Nothing about a person beyond their role on the team's work and how to reach them for it. Your own machines, accounts, credentials and how you like to work go to your personal bank.",
    `- **No secrets.** ${secretsLine(facts.keyManager, "one entry per project")} A key given in the chat goes into the key manager, never into a file or a memory. Identifiers that are not credentials (an account ID, a zone ID, a hostname) belong in the open.`,
    `- **Where each fact goes.** A fact about one project goes to its folder, \`projects/${facts.team.org}/<project>/\`, or to an area inside it, \`projects/${facts.team.org}/<project>/<area>/\`, scoped to the project that owns the account or system. A fact shared across the projects goes to a project of its own for what the team shares, such as \`projects/${facts.team.org}/shared/\`. A department is an org of its own beside \`${facts.team.org}\`.`,
    "- **A fact about you, or work that is not the team's,** goes to your personal bank. Your run's instructions say whether you keep a private copy of team facts there; that switch is yours, off unless you turned it on, and a private copy points at the team memory rather than restating it.",
    sharedRules(facts.name, home, "`PROJECT.md` or `AREA.md`"),
    `- **Land what you promote.** \`memory_promote\` opens the pull request on ${facts.repository.forge}, merges it when the bank allows and checks the file is on main, in the session the fact was learned. Memory pull requests merge on their own; one that touches orientation, a \`decisions/\` folder, a status or this file waits for review: an owner other than its author approves it, or, while the bank has one owner, that owner merges it. The owners are ${facts.owners.join(", ")}.`,
    `- **Every problem found is an issue.** Anything broken, misconfigured or owed is filed in ${facts.repository.path} on ${facts.repository.forge} when it is found, with the evidence and a "done when" checklist. Read a project's open issues before working on it, and close what your work fixes, saying how it was verified.`,
    "",
  ].join("\n");

/** A team bank's first commit (ADR 0037): `BANK.md` with its owners, the README, the team's org with the home folder, and a folder per first project. */
export const renderTeamBank = (facts: TeamBankFacts): BankTemplateFiles => {
  const org = facts.team.org;
  const home = `projects/${org}/${TEAM_HOME}/`;
  const purpose = `The ${facts.team.name} team's shared facts, a folder per project. Shared with the team: no personal facts, no secrets.`;
  const body = teamBody(facts, home);
  const manifest = withFrontmatter(
    {
      name: facts.name,
      kind: "team",
      purpose,
      entities: [
        { name: facts.team.name, aliases: [org], folder: `${org}/` },
        ...facts.projects.map((project) => ({ name: project.name, aliases: [project.folder], folder: `${org}/${project.folder}/` })),
      ],
      orientation: [],
      owners: [...facts.owners],
      ...sharedKeys("pull-request"),
    },
    body,
  );
  return {
    "BANK.md": manifest,
    "README.md": readme(facts.name, purpose, body),
    [`projects/${org}/${SCOPE_FILES.org}`]: folderFile("org", facts.team.name, `The ${facts.team.name} team`),
    [`${home}${SCOPE_FILES.project}`]: folderFile("project", "The bank", "This bank's own facts: accounts, the secrets layout and where work is tracked"),
    // A first project at the home folder is the home folder: its file stays the home's.
    ...Object.fromEntries(facts.projects.filter((project) => project.folder !== TEAM_HOME).map((project) => [`projects/${org}/${project.folder}/${SCOPE_FILES.project}`, folderFile("project", project.name, project.name)])),
  };
};

/** The forges a bank's workflow is written for, each reading its own workflow folder. */
export const BANK_WORKFLOW_FORGES = { github: ".github/workflows", forgejo: ".forgejo/workflows", gitea: ".gitea/workflows" } as const;
export type BankWorkflowForge = keyof typeof BANK_WORKFLOW_FORGES;

/** Where a bank vendors the built validator. */
export const VENDORED_VALIDATOR_PATH = ".agent-harness/validate.mjs";

/**
 * A bank's `validate` workflow for its forge (banks spec, "Bank CI"): on
 * every pull request and every push to main, the vendored `validate.mjs`
 * with Node, then the bank's own secret scan when it has one (the command
 * that runs it, `bash scripts/validate.sh` in the two banks the migration
 * brings over). A GitHub or Gitea runner sets Node up; a Forgejo runner runs
 * the job in a Node container.
 */
export const bankValidatorWorkflow = ({ forge, secretScan }: { readonly forge: BankWorkflowForge; readonly secretScan?: string }): { readonly path: string; readonly text: string } => {
  const runner = forge === "forgejo" ? ["    runs-on: docker", "    container:", "      image: node:24"] : ["    runs-on: ubuntu-latest"];
  const node = forge === "forgejo" ? [] : ["      - uses: actions/setup-node@v4", "        with:", "          node-version: 24"];
  const text = [
    `# The bank's gate, written by ${PRODUCT_NAME}: on every pull request and every push to main, the`,
    "# vendored bank validator, stamped on its first line with the version of its rules, beside the",
    "# bank's own secret scan. A newer validator arrives as a pull request replacing the file.",
    "name: validate",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  validate:",
    ...runner,
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...node,
    "      - name: bank validator",
    `        run: node ${VENDORED_VALIDATOR_PATH}`,
    ...(secretScan === undefined ? [] : ["      - name: secret scan", `        run: ${secretScan}`]),
    "",
  ].join("\n");
  return { path: `${BANK_WORKFLOW_FORGES[forge]}/validate.yml`, text };
};
