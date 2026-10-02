/**
 * The state import's coordinator (switch-over spec, "Preview, application
 * and re-run"; #1165): one per environment, so one import or dry run runs
 * there at a time. Each holds the environment while it is preparing (reading
 * the stores and planning) and applying (carrying its items), and releases
 * it as it finishes or fails, however it ends; another asked for meanwhile
 * is refused, which `stateImport.run` answers `conflict` (reason
 * `import_in_progress`). A dry run holds it as an import does, so a preview
 * never reads a plan an import is changing under it, but reserves nothing
 * once it ends: an import plans again.
 */

/** Where an import or dry run is: preparing and applying hold the environment; finished and failed have released it. */
export type ImportPhase = "preparing" | "applying" | "finished" | "failed";

/** The import or dry run under way, or the last one, and where it is. */
export interface ImportState {
  /** The command id of the `stateImport.run` that asked for it. */
  readonly importId: string;
  readonly dryRun: boolean;
  readonly phase: ImportPhase;
}

export interface ImportCoordinator {
  /** The import or dry run under way, or the last one's end; null before the first. */
  state(): ImportState | null;
  /**
   * Runs `work` as the environment's one import or dry run, preparing until
   * it calls `applying`: null, and `work` never runs, while another holds the
   * environment. Whatever `work` answers or throws is this answer's.
   */
  exclusive<T>(importId: string, dryRun: boolean, work: (applying: () => void) => Promise<T>): Promise<T> | null;
}

export const createImportCoordinator = (): ImportCoordinator => {
  let current: ImportState | null = null;
  const holds = (): boolean => current?.phase === "preparing" || current?.phase === "applying";
  return {
    state: () => current,
    exclusive(importId, dryRun, work) {
      if (holds()) return null;
      let state: ImportState = { importId, dryRun, phase: "preparing" };
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
