import type { Notice, NoticeInput, Notices } from "../notices.js";

/**
 * Rows in `projections.notices` about something an environment holds that
 * people know by a name only some of its events carry (#320, #384): a forge
 * account by its origin, which only its add names; a key-manager connection
 * by its label, which its add and a relabelling name. The names heard are
 * kept per environment, history's too, and the request cache's list is read
 * beside them. A row about one known to neither (its add was before the
 * stream's cursor) waits while the list is read from the environment once
 * its connection is ready, and is raised once it answers, the rows behind
 * it waiting their turn so they keep the order they were heard in. One the
 * answer does not name either (removed meanwhile, or no answer) is said
 * without its name. A step that must follow a row, such as its withdrawal,
 * waits its turn behind it the same way.
 */

export interface NamedRowsHost {
  readonly notices: Notices;
  /** The notice a row's words are raised as. */
  readonly draft: (message: string) => NoticeInput;
  /** The name the request cache's list gives `id` on the environment, when it holds the list and the list names it; never fetches. */
  readonly held: (environmentId: string, id: string) => string | null;
  /** Reads the environment's names, by id, once its connection is ready; null when it could not. */
  readonly list: (environmentId: string) => Promise<ReadonlyMap<string, string> | null>;
  readonly report: (error: unknown) => void;
}

export interface NamedRows {
  /** Notes the name an event gives `id`, heard as news or as history. */
  named(environmentId: string, id: string, name: string): void;
  /**
   * Raises `words` once the name of `id` is known (null when it could not be), after every row heard before it; a row about no one
   * thing (`id` null) waits its turn alone. `raised` hears the notice once it is raised.
   */
  say(environmentId: string, id: string | null, words: (name: string | null) => string, raised?: (notice: Notice) => void): void;
  /** Does `act` once every row heard before it is raised. */
  inTurn(environmentId: string, act: () => void): void;
  /** Lets go of an environment's names: it was removed. A row waiting for a name is raised no more. */
  forget(environmentId: string): void;
  close(): void;
}

/** A row still to raise, its words once the name of what it is about is known, or a step to take in its turn. */
type Waiting =
  | { readonly id: string | null; readonly words: (name: string | null) => string; readonly raised: ((notice: Notice) => void) | undefined }
  | { readonly id: null; readonly act: () => void };

/** What is known of one environment's names. */
interface Known {
  readonly names: Map<string, string>;
  /** Rows waiting behind a name, in the order they were heard. */
  readonly waiting: Waiting[];
  looking: boolean;
}

export const createNamedRows = (host: NamedRowsHost): NamedRows => {
  const known = new Map<string, Known>();
  let closed = false;

  const knownOf = (environmentId: string): Known => {
    let state = known.get(environmentId);
    if (state === undefined) known.set(environmentId, (state = { names: new Map(), waiting: [], looking: false }));
    return state;
  };

  const nameOf = (environmentId: string, state: Known, id: string): string | null => state.names.get(id) ?? host.held(environmentId, id);

  /** Raises every waiting row whose name is known, in order, and looks the next unknown one up. */
  const drain = (environmentId: string, state: Known, lookedUp: boolean): void => {
    while (state.waiting.length > 0) {
      const [next] = state.waiting as [Waiting];
      const name = next.id === null ? null : nameOf(environmentId, state, next.id);
      if (name === null && next.id !== null && !lookedUp) return lookUp(environmentId, state);
      state.waiting.shift();
      if ("act" in next) next.act();
      else {
        const notice = host.notices.raise(environmentId, host.draft(next.words(name)));
        next.raised?.(notice);
      }
    }
  };

  const lookUp = (environmentId: string, state: Known): void => {
    if (state.looking) return;
    state.looking = true;
    void host
      .list(environmentId)
      .catch((error: unknown) => {
        host.report(error);
        return null;
      })
      .then((names) => {
        state.looking = false;
        if (closed || known.get(environmentId) !== state) return;
        // A name heard is kept over the list's, which may have been read before it was given.
        for (const [id, name] of names ?? []) if (!state.names.has(id)) state.names.set(id, name);
        drain(environmentId, state, true);
      });
  };

  return {
    named(environmentId, id, name) {
      if (!closed) knownOf(environmentId).names.set(id, name);
    },
    say(environmentId, id, words, raised) {
      if (closed) return;
      const state = knownOf(environmentId);
      state.waiting.push({ id, words, raised });
      drain(environmentId, state, false);
    },
    inTurn(environmentId, act) {
      if (closed) return;
      const state = knownOf(environmentId);
      state.waiting.push({ id: null, act });
      drain(environmentId, state, false);
    },
    forget(environmentId) {
      known.delete(environmentId);
    },
    close() {
      closed = true;
      known.clear();
    },
  };
};
