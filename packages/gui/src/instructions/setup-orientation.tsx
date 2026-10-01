import type { EnvironmentView } from "@agent-harness/client-runtime";
import type { OrientationRow } from "@agent-harness/contracts";
import { useMemo } from "react";
import { useSettingsValues } from "../settings/settings-values.js";
import { useFollowed, useRuntime } from "../window-context.js";
import { Orientation } from "./orientation.js";

/** Preview a new run of the default account at the environment's home, showing only its Orientation part. */
export const SetupOrientation = ({ view, row }: { readonly view: EnvironmentView; readonly row: OrientationRow }) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(view.environmentId);
  const preferred = settings.values?.["accounts.defaultAccount"];
  const account = row.accounts.find((account) => account.accountId === preferred) ?? row.accounts[0];
  const accountId = account?.accountId;
  const home = useFollowed(useMemo(() => accountId === undefined ? undefined : runtime.requests.cached(view.environmentId, "workspaces.browse", {}), [runtime, view.environmentId, accountId]));
  const path = home?.result?.path;
  const preview = useFollowed(useMemo(() => accountId === undefined || path === undefined ? undefined : runtime.requests.cached(view.environmentId, "instructions.preview", { accountId, workspace: { kind: "directory", path } }), [runtime, view.environmentId, accountId, path]));
  const block = preview?.result?.parts.find((part) => part.layer === "user" && part.id === "orientation");
  const error = home?.error ?? preview?.error;
  return (
    <>
      <Orientation view={view} row={block === undefined ? row : { ...row, text: block.text, unreadRegistries: preview?.result?.manifest.unreadRegistries ?? row.unreadRegistries }} />
      {error != null && <p className="text-sm text-amber">Could not preview the run: {error.message}</p>}
    </>
  );
};
