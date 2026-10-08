import type { SetupAction } from "@agent-harness/contracts";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { ForgeAccountRow } from "./forge-account-row.js";
import { ForgesList } from "./forges-pane.js";

/**
 * The Forges step's card (the Set up specification, "4. Forges"; forge
 * spec, "The Forges step"; ADR 0020, ADR 0032, ADR 0033; #589): where the
 * step stands (`StepStatus`), then the Forges row's list (#419) with a row
 * per forge account (`ForgeAccountRow`) and Add a forge, whose `gh` paths
 * are the step's: this computer's `gh`, handed over once, on a remote
 * environment alone, since this machine's environment reads the same `gh`
 * as its own; and the environment's own `gh` wherever `forge.gh.probe`
 * finds one. Without the `forge` flag it holds the flag's line; without
 * `admin` it is read-only with the capability's line. Where the list reads
 * the environment's own `gh`, Install gh and Update gh are drawn there, in
 * place, never twice in the status line above (#1849). No GitLab walkthrough
 * or expiry warning: both are milestone 2's (ADR 0033).
 */
/** The step's gh fixes, which the list draws beside what it reads of gh. */
const GH_FIXES: readonly SetupAction[] = ["install", "update"];

export const ForgesCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  const ghInPlace = runtime.capability(environmentId, "forge").status === "present" && runtime.capability(environmentId, "forge.gh.probe").status === "present";
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} handledActions={ghInPlace ? GH_FIXES : []} />
      {view !== undefined && <ForgesList view={view} Account={ForgeAccountRow} gh={{ computer: view.kind !== "local", machine: true }} />}
    </>
  );
};
