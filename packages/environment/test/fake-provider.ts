import type { ProviderTranscripts } from "../src/sessions/deletion.js";

/**
 * The scripted fake provider the test helper starts an environment with.
 * There is no adapter host yet: the adapter contract, and the fake adapter
 * that replaces this, arrive with #119. Until then it holds the replies a
 * test scripts, so every test already names its provider and #119 changes
 * what the helper does with it rather than every call site, and the one
 * capability the environment already calls: deleting a provider transcript
 * when a session is purged (session-state spec, "Deletion, grace and purge").
 */
export interface FakeProvider {
  readonly kind: "fake";
  /** The replies a run will give, in order; nothing reads them until #119. */
  readonly script: readonly string[];
  /** What the helper hands the environment: `deleteTranscript` present only when the fake declares it. */
  readonly transcripts: ProviderTranscripts;
  /** The sessions whose transcripts the environment asked the fake to delete, in order, whether or not the delete failed. */
  readonly deletedTranscripts: readonly string[];
}

export interface FakeProviderOptions {
  /**
   * Whether the fake declares transcript delete: `true` deletes (and
   * records it), `{ fails }` records the call and throws `fails`. Preset:
   * not declared, as an adapter without the capability.
   */
  readonly deleteTranscript?: true | { readonly fails: string };
}

export const fakeProvider = (script: readonly string[] = [], options: FakeProviderOptions = {}): FakeProvider => {
  const deletedTranscripts: string[] = [];
  const declared = options.deleteTranscript;
  const transcripts: ProviderTranscripts =
    declared === undefined
      ? {}
      : {
          deleteTranscript: (sessionId) => {
            deletedTranscripts.push(sessionId);
            if (declared !== true) throw new Error(declared.fails);
          },
        };
  return { kind: "fake", script, transcripts, deletedTranscripts };
};
