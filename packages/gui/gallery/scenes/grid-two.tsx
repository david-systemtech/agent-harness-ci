import type { LadderName } from "@agent-harness/theme";
import { useEffect } from "react";
import { App } from "../../src/app.js";
import { PANE_CARD_UNSCROLLABLE } from "../geometry.js";
import { prepareWorld, startWorld } from "../world.js";
import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const first = "0199dd00-0000-4000-8000-000000000001";
const second = "0199dd00-0000-4000-8000-000000000002";
export const script: Script = { environments: [{ name: "desk", reach: "local", environmentId, capabilities: ["workspaceChecks"], sessions: (() => [
  { id: first, title: "Check the ledger", workspace: { kind: "directory", path: "/work/ledger" }, pullRequests: [{ url: "https://forge.example.test/team/ledger/pulls/12", state: "open", mergedAt: null, closedAt: null }] },
  { id: second, title: "Review the receipt parser", workspace: { kind: "worktree", path: "/work/ledger-review", repository: "/work/ledger", branch: "review" } },
])() }] };
export const presentation: Partial<PresentationValues> = { paneLayout: { focused: "pane-2", rows: [{ id: "row-1", height: 100, panes: [
  { id: "pane-1", width: 50, session: { environmentId, sessionId: first } },
  { id: "pane-2", width: 50, session: { environmentId, sessionId: second } },
] }] } };

/** docs/specs/look.md §9.3 and §10.1: gapped cards, multi-pane captions and compact controls. */
export const geometry = [
  // The 245px sidebar and 7px separator leave equal cards in both capture sizes.
  { selector: "[data-grid-card]", width: (window.innerWidth - 252) / 2, tolerance: 1 },
  PANE_CARD_UNSCROLLABLE,
  { selector: "[data-pane-caption]", height: 32 },
  { selector: '[aria-label="Resize the panes"]', width: 7 },
  { selector: '[aria-label="Close the pane"]', width: 24, height: 24 },
  { selector: "[data-caption-run-info] > button", width: 24, height: 24 },
];

export async function createGridWorld() {
  const prepared = await prepareWorld(script, { presentation });
  prepared.world.environment("desk").wire.answer("checks.get", ({ sessionId }) => ({ result: {
    workspace: sessionId === first ? "/work/ledger" : "/work/ledger-review", command: null,
  } }));
  const holders = await startWorld(prepared, prepared.paired);
  return { prepared, holders };
}

const { prepared, holders } = await createGridWorld();
export default function GridTwo({ ladder }: { readonly ladder: LadderName }) {
  useEffect(() => { holders.presentation.set("lightOrDark", ladder); }, [ladder]);
  useEffect(() => () => {
    holders.stopFollowing();
    void holders.presentation.close();
    void holders.runtime.close();
  }, []);
  return <App {...holders} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />;
}
