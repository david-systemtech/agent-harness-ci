/**
 * The scripted fake provider the test helper starts an environment with.
 * There is no adapter host yet: the adapter contract, and the fake adapter
 * that replaces this, arrive with #119. Until then it only holds the replies
 * a test scripts, so every test already names its provider and #119 changes
 * what the helper does with it rather than every call site.
 */
export interface FakeProvider {
  readonly kind: "fake";
  /** The replies a run will give, in order; nothing reads them until #119. */
  readonly script: readonly string[];
}

export const fakeProvider = (script: readonly string[] = []): FakeProvider => ({ kind: "fake", script });
