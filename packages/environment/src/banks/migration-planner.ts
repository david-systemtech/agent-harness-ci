import { stringify } from "yaml";
import { BANK_CAPS, BANK_LAYOUT, RepositoryIdentity, REVIEWED_CLASSES, bankValidatorWorkflow, VENDORED_VALIDATOR_PATH, type BankMigrationChoices, type BankMigrationReport, type BankWorkflowForge } from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";

const markdown = (data: Record<string, unknown>, body = "") => `---\n${stringify(data, { lineWidth: 0 })}---\n${body}`;

/** Pure shared planner: all changes happen in a copy; unresolved authoring stays visible in the report. */
export const planBankMigration = (source: BankFiles, choices: BankMigrationChoices, target: { name: string; land: "commit" | "pull-request"; forge: BankWorkflowForge; validator: string }) => {
  const files: Record<string, string> = { ...source };
  const renames: BankMigrationReport["renames"] = [];
  const moves: BankMigrationReport["moves"] = [];
  const decisions: BankMigrationReport["decisions"] = [];
  const originalTree = bankTreeOf(Object.keys(source));
  const rename = (data: Record<string, unknown>, path: string, from: string, to: string) => {
    if (!Object.hasOwn(data, from)) return;
    if (!Object.hasOwn(data, to)) data[to] = data[from];
    else if (JSON.stringify(data[from]) !== JSON.stringify(data[to])) decisions.push({ path, value: from, reason: `Both ${from} and ${to} exist with different values; confirm which to keep.` });
    delete data[from];
    renames.push({ path, from, to });
  };
  const identities = (value: unknown, path: string): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((entry: unknown) => {
      if (typeof entry !== "string" || RepositoryIdentity.safeParse(entry).success) return entry;
      const mapped = choices.repositoryMappings?.[entry];
      if (mapped) return mapped;
      decisions.push({ path, value: entry, reason: "Choose a repository identity for this directory-name scope." });
      return entry;
    });
  };
  for (const [path, repair] of Object.entries(choices.artefactRepairs ?? {})) {
    if (!Object.hasOwn(source, path)) throw new Error("An artefact repair must name an existing scope file.");
    files[path] = repair;
  }
  // Only scope artefacts get key renames; memory descriptions retain their meaning.
  for (const [path, text] of Object.entries(files)) {
    if (!/^projects\/[^/]+\/[^/]+\/(?:[^/]+\/)?(?:PROJECT|AREA|SYSTEM)\.md$/.test(path)) continue;
    const parsed = readBankMarkdown(text);
    if (!parsed.ok) {
      decisions.push({ path, value: "frontmatter", reason: "Supply a parsing artefact repair; malformed text is never guessed or discarded." });
      continue;
    }
    const data = { ...parsed.data };
    rename(data, path, "summary", "line");
    rename(data, path, "code", "repos");
    data.topics ??= {};
    data.repos = identities(data.repos ?? [], path);
    const destination = path.replace(/SYSTEM\.md$/, "AREA.md");
    if (destination !== path) {
      if (Object.hasOwn(files, destination)) throw new Error("An area rename must not replace an existing file.");
      delete files[path];
      moves.push({ from: path, to: destination });
    }
    files[destination] = markdown(data, parsed.body);
  }
  for (const memory of originalTree.memories) {
    const text = files[memory.path]!;
    const parsed = readBankMarkdown(text);
    if (!parsed.ok || typeof parsed.data.metadata !== "object" || parsed.data.metadata === null) continue;
    const metadata = parsed.data.metadata as Record<string, unknown>;
    const mapped = identities(metadata.applies_to, memory.path);
    if (JSON.stringify(mapped) !== JSON.stringify(metadata.applies_to)) files[memory.path] = markdown({ ...parsed.data, metadata: { ...metadata, applies_to: mapped } }, parsed.body);
  }
  const tree = bankTreeOf(Object.keys(files));
  for (const org of tree.orgs) {
    const path = `${org}ORG.md`;
    if (!Object.hasOwn(files, path)) files[path] = markdown({ line: `${org.split("/")[1]} work and projects` });
  }
  const parsedManifest = readBankMarkdown(files["BANK.md"] ?? "");
  if (parsedManifest.ok) {
    const data = { ...parsedManifest.data };
    if (choices.purpose !== undefined && Object.hasOwn(data, "description")) data.description = choices.purpose;
    if (choices.purpose !== undefined) data.purpose = choices.purpose;
    rename(data, "BANK.md", "description", "purpose");
    delete data.index;
    data.name ??= target.name;
    data.kind ??= "personal";
    data.purpose = choices.purpose ?? data.purpose;
    data.entities = choices.entities ?? data.entities ?? [...tree.orgs].map((org) => ({ name: org.split("/")[1], aliases: [org.split("/")[1]], folder: org.slice("projects/".length) }));
    data.memories = { glob: BANK_LAYOUT.glob, scope: BANK_LAYOUT.scope, schema: BANK_LAYOUT.schema };
    data.docs ??= { globs: ["projects/**/{PROJECT,AREA,HANDOFF,PLAN}.md", "reference/**/*.md"] };
    const write = typeof data.write === "object" && data.write !== null ? data.write as Record<string, unknown> : {};
    const merge = typeof write.merge === "object" && write.merge !== null ? write.merge as Record<string, unknown> : {};
    data.write = { ...write, place: BANK_LAYOUT.place, land: target.land, merge: { memories: merge.memories ?? "auto", reviewed: [...REVIEWED_CLASSES] } };
    if (choices.orientationDrafts !== undefined || !Array.isArray(data.orientation) || data.orientation.length === 0) {
      const home = data.kind === "team" ? `${[...tree.orgs][0] ?? "projects/team/"}bank/` : "projects/personal/memory-bank/";
      files[`${home.split("/").slice(0, 2).join("/")}/ORG.md`] ??= markdown({ line: "The bank's own work and projects" });
      files[`${home}PROJECT.md`] ??= markdown({ line: "The bank's own orientation pointers", topics: {}, repos: [] });
      const names = originalTree.memories.slice(0, 3).flatMap(({ path }) => {
        const memory = readBankMarkdown(files[path] ?? "");
        return memory.ok && typeof memory.data.name === "string" ? [memory.data.name] : [];
      });
      const drafts = choices.orientationDrafts ?? [{ name: "bank-orientation", description: "Before using this bank - short pointers into its existing facts for orientation", body: `Start with ${names.map((name) => `[[${name}]]`).join(", ") || "this bank's project folders"}. Follow the bank's folder pointers for further facts.\n` }];
      const oldOrientation = new Set(Array.isArray(data.orientation) ? data.orientation : []);
      const authored = new Set<string>();
      for (const draft of drafts) {
        if (authored.has(draft.name)) throw new Error("Orientation drafts must have distinct names.");
        authored.add(draft.name);
        const existing = originalTree.memories.find(({ stem }) => stem === draft.name);
        if (existing && (!oldOrientation.has(draft.name) || existing.scope !== home)) {
          decisions.push({ path: "BANK.md", value: draft.name, reason: "The proposed orientation name is already in use outside orientation; choose a new name." });
          continue;
        }
        files[`${home}memories/${draft.name}.md`] = markdown({ name: draft.name, description: draft.description, metadata: { type: "reference" } }, draft.body);
      }
      data.orientation = [...authored];
    }
    files["BANK.md"] = markdown(data, parsedManifest.body);
  }
  delete files["INDEX.md"];
  for (const [pointer, topics] of Object.entries(choices.topics ?? {})) {
    if (!pointer.startsWith(`${target.name}:`)) throw new Error("Accepted topics must name the bank being migrated.");
    const scope = `projects/${pointer.slice(pointer.indexOf(":") + 1)}`;
    const artefact = `${scope}${scope.split("/").length === 4 ? "PROJECT.md" : "AREA.md"}`;
    const folder = readBankMarkdown(files[artefact] ?? "");
    if (!folder.ok) throw new Error("Accepted topics need a parsing scope artefact.");
    const assigned = new Set<string>();
    for (const [topic, authored] of Object.entries(topics)) {
      for (const name of authored.memories) {
        if (assigned.has(name)) throw new Error("A memory may be accepted into only one topic.");
        const memory = tree.memories.find((memory) => memory.scope === scope && memory.topic === null && readBankMarkdown(files[memory.path] ?? "").ok && memory.stem === name);
        if (!memory) throw new Error("Accept only existing flat memories in the chosen scope.");
        const destination = `${scope}memories/${topic}/${memory.stem}.md`;
        if (Object.hasOwn(files, destination)) throw new Error("A topic move must not replace an existing file.");
        files[destination] = files[memory.path]!;
        delete files[memory.path];
        assigned.add(name);
        moves.push({ from: memory.path, to: destination });
      }
    }
    const declarations = typeof folder.data.topics === "object" && folder.data.topics !== null ? folder.data.topics : {};
    files[artefact] = markdown({ ...folder.data, topics: { ...declarations, ...Object.fromEntries(Object.entries(topics).map(([name, topic]) => [name, topic.line])) } }, folder.body);
  }
  const proposals: BankMigrationReport["proposals"] = [];
  const finalTree = bankTreeOf(Object.keys(files));
  for (const scope of [...finalTree.projects, ...finalTree.areas]) {
    const members = finalTree.memories.filter((memory) => memory.scope === scope);
    const flat = members.filter((memory) => memory.topic === null);
    if (flat.length + new Set(members.filter((memory) => memory.topic !== null).map((memory) => memory.topic)).size <= BANK_CAPS.indexLines) continue;
    const groups = new Map<string, string[]>();
    for (const memory of flat) groups.set(memory.stem.split("-")[0]!, [...(groups.get(memory.stem.split("-")[0]!) ?? []), memory.stem]);
    proposals.push({ pointer: `${target.name}:${scope.slice("projects/".length)}`, count: members.length, clusters: [...groups].map(([prefix, memories]) => ({ prefix, memories: memories.sort() })) });
  }
  const workflow = bankValidatorWorkflow({ forge: target.forge, ...(choices.secretScan && { secretScan: choices.secretScan }) });
  for (const path of choices.retiredWorkflows ?? []) delete files[path];
  for (const [path, text] of Object.entries(source)) {
    if (/^\.(?:forgejo|github|gitea)\/workflows\//.test(path) && !choices.retiredWorkflows?.includes(path) && /python|cerebro|bank check/i.test(text)) decisions.push({ path, value: "workflow", reason: "Confirm replacement of the old bank check and retain its secret scan explicitly." });
    if (/^\.(?:forgejo|github|gitea)\/workflows\//.test(path) && (path === workflow.path || choices.retiredWorkflows?.includes(path)) && /gitleaks|secret[-_ ]?scan|scripts\/validate\.sh/i.test(text) && !choices.secretScan) decisions.push({ path, value: "secret-scan", reason: "Supply the retained secret-scan command before replacing this workflow." });
    if (/^scripts\//.test(path) && choices.secretScan?.includes(path) && /python|cerebro|bank check/i.test(text)) decisions.push({ path, value: "secret-scan", reason: "The selected scan still invokes the retired bank check; select an independent secret scan." });
  }
  files[workflow.path] = workflow.text;
  files[VENDORED_VALIDATOR_PATH] = target.validator;
  const verdict = validateBank({ files });
  const before = originalTree.memories.length;
  const after = finalTree.memories.length;
  const report: BankMigrationReport = { valid: verdict.valid && decisions.length === 0, memories: { before, after, added: after - before }, renames, moves, findings: verdict.findings, decisions, proposals };
  const writes: Record<string, string | null> = {};
  for (const path of new Set([...Object.keys(source), ...Object.keys(files)])) if (source[path] !== files[path]) writes[path] = files[path] ?? null;
  return { report, files, writes };
};
