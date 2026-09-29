import { undoableFold, type TranscriptRow } from "@agent-harness/client-runtime";
import { VerbButton } from "../session/verb-button.js";
import { messageWords, useSessionForkRewind } from "./session-fork-rewind.js";

/** What an undo does, in its tooltip. */
const UNDO_DOES = "Takes the rewind back: what it cut comes back in place, and the draft from before it returns while the composer still holds the rewound message.";

/**
 * The rewound strip over the composer (docs/specs/gui.md, "The rewound
 * fold"; ADR 0022; #403): "Rewound to <prompt>" with Undo, from the rewind
 * until a run starts on the session, when it can no longer be undone. Undo
 * is dim with the runtime's reason while it cannot be used now.
 */
export const RewoundStrip = () => {
  const forkRewind = useSessionForkRewind();
  const { rewound } = forkRewind;
  if (rewound === null || !rewound.undoable) return null;
  return (
    <section aria-label="Latest rewind" className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-1 text-xs text-ink-muted">
      <span className="mr-auto min-w-0 truncate">{`Rewound to ${messageWords(rewound.text)}`}</span>
      <VerbButton does={UNDO_DOES} availability={forkRewind.undoRewind} run={forkRewind.undo}>
        Undo
      </VerbButton>
    </section>
  );
};

/**
 * Undo rewind on a rewound fold (#403): drawn on the latest rewind's fold
 * while no run has started since (`undoableFold`), dim with the runtime's
 * reason while it cannot be used now; on an earlier fold, or once a run has
 * started, nothing.
 */
export const UndoOnFold = ({ row }: { readonly row: Extract<TranscriptRow, { kind: "rewound" }> }) => {
  const forkRewind = useSessionForkRewind();
  if (!undoableFold(row, forkRewind.rewound)) return null;
  return (
    <VerbButton does={UNDO_DOES} availability={forkRewind.undoRewind} run={forkRewind.undo}>
      Undo rewind
    </VerbButton>
  );
};
