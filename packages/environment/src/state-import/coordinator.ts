/**
 * The state import's coordinator (switch-over spec, "Preview, application
 * and re-run"; #1165): one per environment, so one import or dry run runs
 * there at a time. Each holds the environment while it is preparing (reading
 * the stores and planning) and applying (carrying its items), and releases
 * it as it finishes or fails, however it ends; account imports share the same
 * exclusion. Another asked for meanwhile is refused, which `stateImport.run` answers `conflict` (reason
 * `import_in_progress`). A dry run holds it as an import does, so a preview
 * never reads a plan an import is changing under it, but reserves nothing
 * once it ends: an import plans again.
 */

/** Where an import or dry run is: preparing and applying hold the environment; finished and failed have released it. */
export type ImportPhase = "preparing" | "applying" | "finished" | "failed";

/** The import or dry run under way, or the last one, and where it is. */
export interface ImportState {
  /** The command id of the `stateImport.run` or `carryOver.run` that asked for it. */
  readonly importId: string;
  /** Which command holds the shared exclusion, so setup names only actual earlier-work imports. */
  readonly kind: "state-import" | "carry-over";
  readonly dryRun: boolean;
  readonly phase: ImportPhase;
}

export interface ImportCoordinator {
  /** The import or dry run under way, or the last one's end; null before the first. */
  state(): ImportState | null;
  /** The import or dry run holding the environment now, preparing or applying; null when none is. */
  underWay(): ImportState | null;
  /**
   * Runs `work` as the environment's one import or dry run, preparing until
   * it calls `applying`: null, and `work` never runs, while another holds the
   * environment. Whatever `work` answers or throws is this answer's.
   * `kind` defaults to the state import; ordinary account imports name themselves explicitly.
   */
  exclusive<T>(importId: string, dryRun: boolean, work: (applying: () => void) => Promise<T>, kind?: ImportState["kind"]): Promise<T> | null;
}

export const createImportCoordinator = (): ImportCoordinator => {
  let current: ImportState | null = null;
  const holds = (): boolean => current?.phase === "preparing" || current?.phase === "applying";
  return {
    state: () => current,
    underWay: () => (holds() ? current : null),
    exclusive(importId, dryRun, work, kind = "state-import") {
      if (holds()) return null;
      let state: ImportState = { importId, dryRun, kind, phase: "preparing" };
      current = state;
      const enter = (phase: ImportPhase): void => {
        state = { ...state, phase };
        current = state;
      };
      const ran = (async () => work(() => enter("applying")))();
      return ran.then(
        (value) => {
          enter("finished");
          return value;
        },
        (error: unknown) => {
          enter("failed");
          throw error;
        },
      );
    },
  };
};
