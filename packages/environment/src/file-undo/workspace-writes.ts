/**
 * The environment's own turns at a workspace's files (switch-over spec,
 * "File undo": serialise workspace writes), keyed by the workspace's real
 * path: a restore holds its turn from choosing its record until the record
 * is consumed, and a capture holds one while it reads, so neither ever reads
 * what the other is halfway through, and two restores in one workspace never
 * choose the same record. Turns are taken in the order asked.
 */
export interface WorkspaceWrites {
  /** Waits for the workspace's turn; resolves with its release, which may be called any number of times. */
  hold(workspace: string): Promise<() => void>;
}

export const createWorkspaceWrites = (): WorkspaceWrites => {
  /** Each workspace's last turn asked for: it settles once released. */
  const last = new Map<string, Promise<void>>();
  return {
    async hold(workspace) {
      const before = last.get(workspace) ?? Promise.resolve();
      let release!: () => void;
      const turn = new Promise<void>((resolve) => (release = resolve));
      const queued = before.then(() => turn);
      last.set(workspace, queued);
      await before;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (last.get(workspace) === queued) last.delete(workspace);
      };
    },
  };
};
