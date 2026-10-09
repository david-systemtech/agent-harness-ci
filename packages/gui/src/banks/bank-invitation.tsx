import type { BankLocation, ForgeAccountRecord } from "@agent-harness/contracts";
import { UserPlus } from "lucide-react";
import { useMemo } from "react";
import { Tooltip } from "../ui/index.js";
import { CopyLine } from "../settings/copy-line.js";
import { ExternalLink } from "../session/external-link.js";
import { useFollowed, useRuntime } from "../window-context.js";

/** The forge owns membership; the bank URL is what another environment previews before joining. */
export const BankInvitation = ({ environmentId, location, forges }: {
  readonly environmentId: string;
  readonly location: Extract<BankLocation, { kind: "remote" }>;
  readonly forges: readonly ForgeAccountRecord[];
}) => {
  const runtime = useRuntime();
  const forge = forges.find((forge) => forge.origin === location.origin || forge.aliases.some((alias) => alias.origin === location.origin && alias.verifiedAt !== null));
  const owners = useFollowed(useMemo(() => forge === undefined ? undefined : runtime.requests.cached(environmentId, "forge.orgs.list", { forgeAccountId: forge.id }), [runtime, environmentId, forge?.id]));
  const host = new URL(location.origin).host;
  const owner = location.repository.split("/")[0];
  const organisation = owners?.result?.owners.some((entry) => entry.login === owner && entry.kind === "organisation") ?? false;
  const join = `${location.origin}/${location.repository}`;
  const github = forge?.kind === "github" || host === "github.com";
  const invite = organisation
    ? github ? `${location.origin}/orgs/${owner}/people` : `${location.origin}/org/${owner}/members`
    : `${join}/settings/${github ? "access" : "collaboration"}`;
  return <>
    <Tooltip content="Invite teammates" keys="Tab, Enter or Space"><span className="inline-flex"><ExternalLink look="inline-flex items-center gap-1.5 text-beam-text underline" url={invite}><UserPlus aria-hidden="true" className="size-4" />Invite teammates on {host}</ExternalLink></span></Tooltip>
    <CopyLine label="Notebook link" text={join} />
  </>;
};
