import { CountGrid } from "./count-grid.js";
import type { CarryOverReport } from "@agent-harness/contracts";

/** The result stays beside the inventory: what carried and each thing that failed, including a partial import. */
export const ImportReport = ({ report }: { readonly report: CarryOverReport }) => (
  <section aria-label="Import result" className="flex flex-col gap-3 rounded-lg border border-hairline bg-inset p-3">
    <h4 className="text-xs font-medium text-ink">Import result</h4>
    <CountGrid label="Imported sessions" rows={[["Imported", report.sessions.imported], ["Archived", report.sessions.archived], ["Missing directory", report.sessions.missingDirectory], ["Already held", report.sessions.held]]} />
    <CountGrid label="Imported memory" rows={[["Copied", report.memory.folders.filter((folder) => folder.outcome === "copied").length], ["Carried", report.memory.folders.filter((folder) => folder.outcome === "carried").length], ["Kept", report.memory.folders.filter((folder) => folder.outcome === "kept").length], ["Unmappable", report.memory.unmappable.length]]} />
    {report.skills !== undefined && <CountGrid label="Imported skills and commands" rows={[["Copied", report.skills.copied.length], ["Kept", report.skills.kept.length], ["Checkouts offered", report.skills.offered.length], ["Invalid", report.skills.invalid.length]]} />}
    {report.skills?.invalid.map((item) => (
      <p key={item.from} className="text-xs text-amber">
        {item.from}: {item.problems.map((problem) => problem.message).join(" ")}
      </p>
    ))}
    {report.failed.map((failure, index) => (
      <p key={index} className="text-xs text-amber">
        {failure.folder ?? failure.providerSessionId ?? "Directory"}: {failure.message}
      </p>
    ))}
  </section>
);
