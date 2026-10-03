import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { ContainmentDefault } from "../../src/permissions/containment-default.js";
import { useObservable, useRuntime } from "../../src/window-context.js";

export const script: Script = { environments: [{ name: "desk", reach: "local", sessions: [] }] };

/** The Permissions pane and setup card share this custom containment editor. */
export default function PermissionsContainmentScene() {
  const views = useObservable(useRuntime().projections.environments);
  const view = views.find((candidate) => candidate.phase === "ready");
  return <main className="min-h-screen bg-abyss p-6 text-ink">
    <section aria-label="Permissions" className="mx-auto flex max-w-[768px] flex-col gap-3">
      <h1 className="text-sm font-semibold">Permissions</h1>
      {view !== undefined && <ContainmentDefault view={view} writable />}
    </section>
  </main>;
}

/** look.md §12.2: 768px body cap, human label above smaller mono key. */
export const geometry = [
  { selector: "section[aria-label='Permissions']", width: 768, tolerance: 0.1 },
  { selector: "[role=radiogroup] > span[id]", height: 18, tolerance: 0.1 },
  { selector: "[role=radiogroup] > span.font-mono", height: 16, tolerance: 0.1 },
] as const;
