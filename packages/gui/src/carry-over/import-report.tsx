import type { CarryOverReport } from "@agent-harness/contracts";

/** The result stays beside the inventory: what carried and each thing that failed, including a partial import. */
export const ImportReport = ({ report }: { readonly report: CarryOverReport }) => (
  <section aria-label="Import result" className="flex flex-col gap-1">
    <p className="text-sm text-ink">
      Imported {report.sessions.imported} sessions; {report.sessions.archived} archived; {report.sessions.missingDirectory} missing
      directory; {report.sessions.held} already held.
    </p>
    <p className="text-sm text-ink">
      Memory: {report.memory.folders.filter((folder) => folder.outcome === "copied").length} copied;{" "}
      {report.memory.folders.filter((folder) => folder.outcome === "carried").length} carried;{" "}
      {report.memory.folders.filter((folder) => folder.outcome === "kept").length} kept; {report.memory.unmappable.length} unmappable.
    </p>
    {report.skills !== undefined && (
      <p className="text-sm text-ink">
        Skills and commands: {report.skills.copied.length} copied; {report.skills.kept.length} kept; {report.skills.offered.length}{" "}
        checkouts offered; {report.skills.invalid.length} invalid.
      </p>
    )}
    {report.skills?.invalid.map((item) => (
      <p key={item.from} className="text-sm text-amber">
        {item.from}: {item.problems.map((problem) => problem.message).join(" ")}
      </p>
    ))}
    {report.failed.map((failure, index) => (
      <p key={index} className="text-sm text-amber">
        {failure.folder ?? failure.providerSessionId ?? "Directory"}: {failure.message}
      </p>
    ))}
  </section>
);
