import { oneLine } from "@agent-harness/client-runtime";
import type { ForgeAccountRecord, ParamsOf } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { Folder, GitBranch, GitFork, Plus, Server, UserRound, UsersRound } from "lucide-react";
import { BankButton, BankField } from "./bank-controls.js";
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
  const bankName = name ?? (primary?.identity === undefined || primary.identity === null ? "personal-memory" : `${primary.identity.login}-memory`);
  const projectName = project ?? firstProject;
  const send = (localOnly: boolean) => create(bankName, { kind: "personal", localOnly, org, project: projectName });
  const invalid = bankName === "" || org === "" || projectName === "";
  return <>
    <BankField icon={GitBranch} label="Bank name"><Input value={bankName} onChange={(event) => setName(event.target.value)} /></BankField>
    <BankField icon={Folder} label="What do you call your own work?"><Input value={org} onChange={(event) => setOrg(event.target.value)} /></BankField>
    <BankField icon={Folder} label="Your first project"><Input value={projectName} onChange={(event) => setProject(event.target.value)} /></BankField>
    <div className="flex flex-wrap gap-1.5"><BankButton label="Create" icon={Plus} variant={primary === undefined ? "outline" : "default"} disabled={busy} reason={primary === undefined ? "Connect a verified primary forge, or keep the bank on this machine." : invalid ? "Fill in the bank name, organisation and first project." : undefined} onClick={() => void send(false)} />
    <BankButton label="Keep it on this machine for now" icon={Server} variant={primary === undefined ? "default" : "outline"} disabled={busy} reason={invalid ? "Fill in the bank name, organisation and first project." : undefined} onClick={() => void send(true)} /></div>
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
  const repositoryName = name ?? slug(team);
  const firstOrg = org ?? slug(team);
  const firstProjects = projects.split("\n").map((name) => name.trim()).filter(Boolean).map((name) => ({ name, folder: slug(name) }));
  return <>
    <BankField icon={GitFork} label="Forge"><Select value={forge?.id ?? ""} onChange={(event) => { pick(event.target.value); setOwner(undefined); }}>
      <option value="" disabled>Choose a verified forge</option>
      {forges.map((forge) => <option key={forge.id} value={forge.id}>{new URL(forge.origin).host} — {forge.identity?.login}</option>)}
    </Select></BankField>
    <BankField icon={UserRound} label="Owner"><Select value={owner?.login ?? ""} disabled={owners?.result === null || owners?.error !== null} onChange={(event) => setOwner(event.target.value)}>
      <option value="" disabled>Choose an owner</option>
      {owners?.result?.owners.map((owner) => <option key={owner.login} value={owner.login}>{owner.login}</option>)}
    </Select></BankField>
    {owners?.error != null && <p role="alert">{oneLine(owners.error.message)}</p>}
    {forge !== undefined && <p>Every teammate needs an account on {new URL(forge.origin).host}.</p>}
    <BankField icon={UsersRound} label="Team name"><Input value={team} onChange={(event) => setTeam(event.target.value)} /></BankField>
    <BankField icon={Folder} label="Repository name"><Input value={repositoryName} onChange={(event) => setName(event.target.value)} /></BankField>
    <BankField icon={Folder} label="First organisation"><Input value={firstOrg} onChange={(event) => setOrg(event.target.value)} /></BankField>
    <BankField wide icon={Folder} label="First projects (one per line)"><Textarea rows={4} title="First projects · Tab to focus, type one project per line" value={projects} onChange={(event) => setProjects(event.target.value)} className="w-full" /></BankField>
    <BankButton label="Create" icon={Plus} variant="default" className="self-start" disabled={busy} reason={forge === undefined ? "Connect a verified forge." : owner === undefined || owners?.error !== null ? "Choose an available owner." : team.trim() === "" || repositoryName === "" || firstOrg === "" || firstProjects.length === 0 ? "Fill in the team, repository, organisation and first projects." : undefined} onClick={() => {
      if (forge !== undefined && owner !== undefined) void create(repositoryName, { kind: "team", forgeAccountId: forge.id, owner, repositoryName, teamName: team, org: firstOrg, projects: firstProjects });
    }} />
  </>;
};
