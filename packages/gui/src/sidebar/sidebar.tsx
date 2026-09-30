import { keepsFold, rowKey, sessionHeadings, type HeadingRow, type SessionRow } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { useOpenPairing } from "../connections/pairing.js";
import { useOpenInPane } from "../session/pane-line.js";
import { Button, Input } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { EnvironmentSection, FoldingSection, type DrawRows } from "./headings.js";
import { SessionRowView } from "./row.js";

/**
 * The sidebar (docs/specs/gui.md, "The window and the sidebar"; #397): every
 * environment's sessions at once, drawn from `projections.sessionList` and
 * `projections.environments` under the headings the terminal UI's rail
 * draws (the client runtime's `sessionHeadings`), each row opening its
 * session in the focused pane. Typing in its filter narrows it to
 * `projections.search`'s rows, in the sidebar's order, with no headings;
 * clearing it brings the headings back. The folds are presentation
 * (`collapsedHeadings`); what is typed in the filter lasts while the window
 * does. Pairing with another environment is at its foot.
 */
export const Sidebar = () => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const list = useObservable(runtime.projections.sessionList);
  const [folded, setFolded] = usePresentation("collapsedHeadings");
  const [layout] = usePresentation("paneLayout");
  const openInPane = useOpenInPane();
  const openPairing = useOpenPairing();
  const [filter, setFilter] = useState("");
  const query = filter.trim();

  const headings = useMemo(
    () => sessionHeadings({ list, environments, folded, matches: null, now: (environmentId) => runtime.environmentNow(environmentId) }),
    [runtime, list, environments, folded],
  );

  /** Folds or opens a heading; the folds of groups no longer listed are dropped as the choice is kept. */
  const fold = (key: string, shut: boolean) =>
    setFolded((held) => {
      const keep = keepsFold(runtime.projections.sessionList.read());
      return { ...Object.fromEntries(Object.entries(held).filter(([heading]) => heading === key || keep(heading))), [key]: shut };
    });

  const views = new Map(environments.map((view) => [view.environmentId, view]));
  const shown = layout.session;
  const rows: DrawRows = (lines: readonly HeadingRow[]) =>
    lines.map((line) => (
      <SessionRowView
        key={line.key}
        line={line}
        environment={views.get(line.row.environmentId)}
        current={shown?.environmentId === line.row.environmentId && shown.sessionId === line.row.summary.id}
        open={() => openInPane(line.row.environmentId, line.row.summary.id)}
      />
    ));

  return (
    <nav aria-label="Sessions" className="flex h-full flex-col gap-3 overflow-y-auto bg-inset p-3">
      <Input type="search" aria-label="Filter the sessions" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
      {query === "" ? (
        headings.map((heading) =>
          heading.kind === "environment" ? (
            <EnvironmentSection key={heading.key} heading={heading} rows={rows} />
          ) : (
            <FoldingSection key={heading.key} heading={heading} fold={fold} rows={rows} />
          ),
        )
      ) : (
        <Matches query={query} rows={rows} />
      )}
      <Button className="mt-auto self-start" onClick={() => openPairing()}>
        Pair with an environment…
      </Button>
    </nav>
  );
};

/**
 * The sidebar narrowed by its filter: `projections.search`'s rows in its
 * order (the sidebar's: pinned, active, snoozed, settled, archived), each
 * drawn as it is under its heading, whatever the folds.
 */
const Matches = ({ query, rows }: { readonly query: string; readonly rows: DrawRows }) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const list = useObservable(runtime.projections.sessionList);
  const found = useObservable(useMemo(() => runtime.projections.search(query), [runtime, query]));
  // Each row as the headings draw it, every heading open: its activity, its marker, a snoozed one's wake time, dim or not.
  const drawn = useMemo(() => {
    const all = sessionHeadings({ list, environments, folded: {}, matches: null, open: true, now: (environmentId) => runtime.environmentNow(environmentId) });
    return new Map(all.flatMap((heading) => heading.rows).map((line) => [line.key, line]));
  }, [runtime, list, environments]);
  const lines = found.flatMap((row: SessionRow) => drawn.get(rowKey(row)) ?? []);
  return lines.length === 0 ? (
    <p className="text-sm text-ink-faint">No session matches “{query}”.</p>
  ) : (
    <ul aria-label={`Sessions matching “${query}”`} className="flex flex-col">
      {rows(lines)}
    </ul>
  );
};
