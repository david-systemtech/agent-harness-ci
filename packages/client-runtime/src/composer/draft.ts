/**
 * The composer's text and its session's draft, kept in step as every
 * renderer keeps them (docs/specs/tui.md, "The composer"; docs/specs/gui.md,
 * "A session pane"; the session-state spec's composer draft). The draft is a
 * session field: what is typed is saved through `drafts.set`, which waits a
 * second after the last key and lays the waiting text over the session's
 * draft at once. A session opened takes its draft once it is known. A draft
 * another client saved replaces the text only while nothing has been typed
 * over what this composer last held, so a keystroke is never lost to a late
 * echo: while this composer's own text waits its second, the session's draft
 * reads as that text, and what another client saved meanwhile comes in
 * behind it.
 *
 * A renderer calls `followDraft` after each change to either side and does
 * what it answers: puts `take` in the box, or saves `save`.
 */

/** What a composer last held in step with its session's draft: the session (any key a renderer names it by) and the text. */
export interface InStep {
  readonly session: string;
  readonly text: string;
}

export interface DraftSides {
  /** The session the composer is open on. */
  readonly session: string;
  /** The session's draft, as `projections.session` reads it (waiting text laid over), `""` for none; undefined until its summary is known. */
  readonly held: string | undefined;
  /** What the composer's box holds now. */
  readonly text: string;
  /**
   * Whether the text is the session's to save: false for something typed for
   * the renderer itself (a slash command it answers), which is sent nowhere and
   * would only be undone.
   */
  readonly saves: boolean;
}

export interface DraftStep {
  /** What the composer holds in step now; undefined until the session's draft is known. */
  readonly inStep: InStep | undefined;
  /** Text to put in the box, the draft's. */
  readonly take?: string;
  /** Text to save as the session's draft (`drafts.set`), `""` clearing it. */
  readonly save?: string;
}

/** The next step of keeping `sides` in step, from what the composer held in step before (`inStep`). */
export const followDraft = (inStep: InStep | undefined, sides: DraftSides): DraftStep => {
  const { session, held, text, saves } = sides;
  if (inStep?.session !== session) {
    // A session just opened: what it holds, once it is known; what was typed before that is kept, and saved over it next.
    if (held === undefined) return { inStep: undefined };
    const opened = { session, text: held };
    return text.length === 0 && held.length > 0 ? { inStep: opened, take: held } : { inStep: opened };
  }
  // Another client's draft, taken while the box holds what this composer last held in step.
  if (held !== undefined && held !== inStep.text && text === inStep.text) return { inStep: { session, text: held }, take: held };
  if (text !== inStep.text && saves) return { inStep: { session, text }, save: text };
  return { inStep };
};
