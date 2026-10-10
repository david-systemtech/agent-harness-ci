import type { CarryOverReport } from "@agent-harness/contracts";
import type { TechnicalDetailsProps } from "../setup/details.js";
import { SetupNotice } from "../setup/notice.js";

/** One account's import, as the environment reported it. */
export interface AccountReport {
  readonly label: string;
  readonly report: CarryOverReport;
}

/** `count` of a kind, singular for one: "1 past chat", "3 past chats". */
export const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The notes folders an import brought over: copied, or carried into a project's memory. */
const notesBrought = ({ memory }: CarryOverReport): number => memory.folders.filter((folder) => folder.outcome !== "kept").length;

/** What did not come over from an account and Try again can bring, each as a line for Details: a session or a notes folder, by what names it. */
const leftBehind = ({ failed }: CarryOverReport): readonly string[] => failed.map((failure) => `${failure.providerSessionId ?? failure.folder ?? "Folder"}: ${failure.message}`);

/** The skills an import left where they are for a problem a re-run cannot fix, each as a line for Details. */
const withProblems = ({ skills }: CarryOverReport): readonly string[] =>
  (skills?.invalid ?? []).map((item) => `${item.from}: ${item.problems.map((problem) => problem.message).join(" ")}`);

/**
 * What the last Bring them over did (setup-copy.md §5.3): the chats and notes
 * folders it brought over, when it brought any; for each
 * account where something did not come over, a notice counting it with the
 * list in Details, and one for its skills with a problem, which Try again
 * would leave where they are; and, once skills came over, where to edit them now.
 */
export const ImportReport = ({ reports, details }: { readonly reports: readonly AccountReport[]; readonly details: (line: string, details: readonly string[]) => TechnicalDetailsProps }) => {
  const chats = reports.reduce((sum, { report }) => sum + report.sessions.imported, 0);
  const notes = reports.reduce((sum, { report }) => sum + notesBrought(report), 0);
  return (
    <section aria-label="What came over" className="flex min-w-0 flex-col gap-2">
      {chats + notes > 0 && <p role="status" className="text-sm text-ink">Brought over {counted(chats, "chat", "chats")} and {counted(notes, "notes folder", "notes folders")}.</p>}
      {reports.map(({ label, report }) => {
        const behind = leftBehind(report);
        if (behind.length === 0) return null;
        const title = `${counted(behind.length, "item", "items")} from ${label} did not come over.`;
        return <SetupNotice key={label} tone="warning" title={title} description="Choose Try again." details={details(title, behind)} />;
      })}
      {reports.map(({ label, report }) => {
        const problems = withProblems(report);
        if (problems.length === 0) return null;
        const title = problems.length === 1 ? `1 skill from ${label} has a problem, so it stays where it is.` : `${problems.length} skills from ${label} have a problem, so they stay where they are.`;
        return <SetupNotice key={`${label}/skills`} tone="warning" title={title} details={details(title, problems)} />;
      })}
      {reports.some(({ report }) => (report.skills?.copied.length ?? 0) > 0) && <p className="text-sm text-ink-muted">Your skills now live in agent-harness. Edit them there.</p>}
    </section>
  );
};
