import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateBank } from "./bank-validator.js";
import { bankValidatorWorkflow, renderPersonalBank, renderTeamBank, type PersonalBankFacts, type TeamBankFacts } from "./bank-templates.js";

const frontmatter = (text: string | undefined): Record<string, unknown> => parse(/^---\n([\s\S]*?)\n---\n/.exec(text ?? "")?.[1] ?? "") as Record<string, unknown>;

const personal: PersonalBankFacts = {
  name: "maya-memory",
  person: { name: "Maya Reyes", login: "maya-reyes" },
  org: "personal",
  project: "homelab",
  repository: { forge: "Forgejo", path: "maya-reyes/maya-memory" },
  keyManager: { product: "OpenBao", path: "agents/maya/" },
};

const team: TeamBankFacts = {
  name: "acme-memory",
  team: { name: "Acme", org: "acme" },
  projects: [
    { name: "Acme Web", folder: "web" },
    { name: "Acme Ads", folder: "ads" },
  ],
  owners: ["maya-reyes"],
  repository: { forge: "GitHub", path: "acme/acme-memory" },
  keyManager: null,
};

describe("the personal bank template", () => {
  it("writes a bank that validates with no finding, memories merging on their own, the home folder ready for orientation", () => {
    const files = renderPersonalBank(personal);
    expect(validateBank({ files })).toMatchObject({ valid: true, findings: [] });
    expect(Object.keys(files).sort()).toEqual([
      "BANK.md",
      "README.md",
      "projects/personal/ORG.md",
      "projects/personal/homelab/PROJECT.md",
      "projects/personal/memory-bank/PROJECT.md",
    ]);
    expect(frontmatter(files["BANK.md"])).toMatchObject({
      name: "maya-memory",
      kind: "personal",
      entities: [{ name: "Maya Reyes", aliases: ["maya-reyes"] }],
      orientation: [],
      write: { land: "pull-request", merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] } },
    });
    expect(files["BANK.md"]).toContain("projects/personal/memory-bank/");
  });

  it("writes a local-only bank that commits on its main and keeps follow-ups in issues/, and a first org of the person's own naming", () => {
    const files = renderPersonalBank({ ...personal, org: "maya", repository: null, keyManager: null });
    expect(validateBank({ files })).toMatchObject({ valid: true, findings: [] });
    expect(frontmatter(files["BANK.md"])).toMatchObject({ write: { land: "commit", merge: { memories: "auto" } } });
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["projects/maya/ORG.md", "projects/maya/homelab/PROJECT.md", "projects/personal/ORG.md", "projects/personal/memory-bank/PROJECT.md"]));
    expect(files["BANK.md"]).toContain("issues/");
  });

  it("renders the README from the body with nothing left to fill", () => {
    const { "README.md": readme = "", "BANK.md": manifest = "" } = renderPersonalBank(personal);
    expect(readme).not.toMatch(/\{\{|\}\}/);
    expect(readme.startsWith("# maya-memory\n")).toBe(true);
    expect(readme).toContain(manifest.slice(manifest.indexOf("\n---\n") + 5).trim());
    expect(readme).toContain("OpenBao under agents/maya/");
    expect(readme).toContain("maya-reyes/maya-memory on Forgejo");
  });
});

describe("the team bank template", () => {
  it("writes a bank that validates with no finding, its owners, an entity and a folder per first project, and the home folder", () => {
    const files = renderTeamBank(team);
    expect(validateBank({ files })).toMatchObject({ valid: true, findings: [] });
    expect(Object.keys(files).sort()).toEqual(["BANK.md", "README.md", "projects/acme/ORG.md", "projects/acme/ads/PROJECT.md", "projects/acme/bank/PROJECT.md", "projects/acme/web/PROJECT.md"]);
    expect(frontmatter(files["BANK.md"])).toMatchObject({
      name: "acme-memory",
      kind: "team",
      owners: ["maya-reyes"],
      entities: [
        { name: "Acme", aliases: ["acme"], folder: "acme/" },
        { name: "Acme Web", aliases: ["web"], folder: "acme/web/" },
        { name: "Acme Ads", aliases: ["ads"], folder: "acme/ads/" },
      ],
      orientation: [],
      write: { land: "pull-request", merge: { memories: "auto" } },
    });
    expect(files["BANK.md"]).toContain("projects/acme/bank/");
  });

  it("renders the README from the shared-bank body with nothing left to fill", () => {
    const readme = renderTeamBank(team)["README.md"] ?? "";
    expect(readme).not.toMatch(/\{\{|\}\}/);
    expect(readme).toContain("No personal or private facts.");
    expect(readme).toContain("acme/acme-memory on GitHub");
  });
});

describe("the bank's validate workflow", () => {
  it.each([
    ["github", ".github/workflows/validate.yml"],
    ["forgejo", ".forgejo/workflows/validate.yml"],
    ["gitea", ".gitea/workflows/validate.yml"],
  ] as const)("runs the vendored validator on %s on every pull request and push to main, beside the bank's secret scan", (forge, path) => {
    const workflow = bankValidatorWorkflow({ forge, secretScan: "bash scripts/validate.sh" });
    expect(workflow.path).toBe(path);
    const document = parse(workflow.text) as { on: Record<string, unknown>; jobs: { validate: { steps: { name?: string; run?: string }[] } } };
    expect(document.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
    const runs = document.jobs.validate.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
    expect(runs).toEqual(["node .agent-harness/validate.mjs", "bash scripts/validate.sh"]);
  });

  it("runs the validator alone for a bank with no secret scan of its own", () => {
    const document = parse(bankValidatorWorkflow({ forge: "github" }).text) as { jobs: { validate: { steps: { run?: string }[] } } };
    expect(document.jobs.validate.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))).toEqual(["node .agent-harness/validate.mjs"]);
  });
});
