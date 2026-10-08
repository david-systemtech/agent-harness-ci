import type { ForgeAccountRecord, ParamsOf } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { Folder, GitBranch, GitFork, Plus, Server, UserRound, UsersRound } from "lucide-react";
import { BankButton, BankField, BankRefusal, useFieldCheck } from "./bank-controls.js";
import { bankRefusal } from "./bank-words.js";
import { Input, Select, Textarea } from "../ui/index.js";
import { useFollowed, useRuntime } from "../window-context.js";

type Creation = ParamsOf<"banks.create">["creation"];
interface CreateProps {
  readonly environmentId: string;
  readonly forges: readonly ForgeAccountRecord[];
  readonly busy: boolean;
  readonly create: (name: string, creation: Creation) => Promise<void>;
}

/** Bank and folder names follow the bank contract; display names keep their spelling. */
const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");

export const PersonalBankForm = ({ forges, busy, create, firstProject }: CreateProps & { readonly firstProject: string }) => {
  const primary = forges.find((forge) => forge.primary);
  const [name, setName] = useState<string>();
  const [org, setOrg] = useState("personal");
  const [project, setProject] = useState<string>();
  const { missing, press } = useFieldCheck<"name" | "org" | "project">();
  const bankName = name ?? (primary?.identity === undefined || primary.identity === null ? "personal-memory" : `${primary.identity.login}-memory`);
  const projectName = project ?? firstProject;
  const send = (localOnly: boolean) => press(
    { name: [bankName, "a name"], org: [org, "what you call your own work"], project: [projectName, "your first project"] },
    () => void create(bankName, { kind: "personal", localOnly, org, project: projectName }),
  );
  return <>
    <BankField icon={GitBranch} label="Name" error={missing.name}><Input value={bankName} onChange={(event) => setName(event.target.value)} /></BankField>
    <BankField icon={Folder} label="What do you call your own work?" hint="Used as a folder name, for example personal." error={missing.org}><Input value={org} onChange={(event) => setOrg(event.target.value)} /></BankField>
    <BankField icon={Folder} label="Your first project" hint="For example the name of a repository you work on." error={missing.project}><Input value={projectName} onChange={(event) => setProject(event.target.value)} /></BankField>
    <div className="flex flex-wrap gap-1.5">
      <BankButton label="Create notebook" icon={Plus} variant={primary === undefined ? "outline" : "default"} disabled={busy} onClick={() => send(false)} />
      <BankButton label="Keep it on this computer for now" icon={Server} variant={primary === undefined ? "default" : "outline"} disabled={busy} onClick={() => send(true)} />
    </div>
  </>;
};

export const TeamBankForm = ({ environmentId, forges, busy, create }: CreateProps) => {
  const runtime = useRuntime();
  const [picked, pick] = useState<string>();
  const forge = forges.find((forge) => forge.id === picked) ?? forges.find((forge) => forge.primary) ?? forges[0];
  const owners = useFollowed(useMemo(() => forge === undefined ? undefined : runtime.requests.cached(environmentId, "forge.orgs.list", { forgeAccountId: forge.id }), [runtime, environmentId, forge?.id]));
  const [ownerLogin, setOwner] = useState<string>();
  const owner = owners?.result?.owners.find((owner) => owner.login === ownerLogin) ?? owners?.result?.owners[0];
  const [team, setTeam] = useState("");
  const [name, setName] = useState<string>();
  const [org, setOrg] = useState<string>();
  const [projects, setProjects] = useState("");
  const { missing, press } = useFieldCheck<"team" | "name" | "org" | "projects">();
  const [unchosen, setUnchosen] = useState<{ readonly forge?: string; readonly owner?: string }>({});
  const repositoryName = name ?? slug(team);
  const firstOrg = org ?? slug(team);
  const firstProjects = projects.split("\n").map((name) => name.trim()).filter(Boolean).map((name) => ({ name, folder: slug(name) }));
  const send = () => {
    setUnchosen(forge === undefined ? { forge: "Choose a forge." } : owner === undefined ? { owner: "Choose the owner from the list." } : {});
    press({ team: [team, "a team name"], name: [repositoryName, "a repository name"], org: [firstOrg, "a first organisation"], projects: [projects, "the first projects"] }, () => {
      if (forge !== undefined && owner !== undefined) void create(repositoryName, { kind: "team", forgeAccountId: forge.id, owner, repositoryName, teamName: team, org: firstOrg, projects: firstProjects });
    });
  };
  return <>
    <BankField icon={GitFork} label="Forge" error={unchosen.forge}><Select value={forge?.id ?? ""} onChange={(event) => { pick(event.target.value); setOwner(undefined); }}>
      <option value="" disabled>Choose a forge</option>
      {forges.map((forge) => <option key={forge.id} value={forge.id}>{new URL(forge.origin).host} — {forge.identity?.login}</option>)}
    </Select></BankField>
    <BankField icon={UserRound} label="Owner" error={unchosen.owner}><Select value={owner?.login ?? ""} disabled={owners?.result === null || owners?.error !== null} onChange={(event) => setOwner(event.target.value)}>
      <option value="" disabled>Choose an owner</option>
      {owners?.result?.owners.map((owner) => <option key={owner.login} value={owner.login}>{owner.login}</option>)}
    </Select></BankField>
    {owners?.error != null && <BankRefusal refusal={bankRefusal(owners.error, "Create notebook")} />}
    {forge !== undefined && <p>Every teammate needs an account on {new URL(forge.origin).host}.</p>}
    <BankField icon={UsersRound} label="Team name" error={missing.team}><Input value={team} onChange={(event) => setTeam(event.target.value)} /></BankField>
    <BankField icon={Folder} label="Repository name" error={missing.name}><Input value={repositoryName} onChange={(event) => setName(event.target.value)} /></BankField>
    <BankField icon={Folder} label="First organisation" error={missing.org}><Input value={firstOrg} onChange={(event) => setOrg(event.target.value)} /></BankField>
    <BankField wide icon={Folder} label="First projects (one per line)" error={missing.projects}><Textarea rows={4} title="First projects · Tab to focus, type one project per line" value={projects} onChange={(event) => setProjects(event.target.value)} className="w-full" /></BankField>
    <BankButton label="Create notebook" icon={Plus} variant="default" className="self-start" disabled={busy} onClick={send} />
  </>;
};
