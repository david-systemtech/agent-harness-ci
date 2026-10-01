import type { PageCallOf, PageDriver, PageDriverKind, PageKey, PageResult, PageVerb } from "@agent-harness/contracts";

/**
 * A scripted page driver (browser spec, "Testing Decisions"; #551): the
 * page-driver contract answered from a script, behind the tool server's
 * driver seam, so a test drives the browser tools through the in-process
 * environment and asserts what the model reads and what the driver was
 * asked. It records every call, and keeps a tab per page key as a browser
 * would: `open` makes one, and `close` closes it in the headless browser
 * only, since a Chrome's or the dock's tab stays for the person.
 *
 * Each verb answers its preset unless a test queues an answer for it
 * (`next`): a value, a refusal, or a function of the call, which may throw
 * to play a driver that breaks its contract.
 */

/** An answer a test queues for a verb: the result, or a function of the call giving it. */
export type ScriptedAnswer<V extends PageVerb> = PageResult<V> | ((call: PageCallOf<V>) => PageResult<V> | Promise<PageResult<V>>);

export interface ScriptedPageDriver extends PageDriver {
  /** Every call the driver was handed, in order. */
  readonly calls: PageCallOf<PageVerb>[];
  /** The page keys with a tab open now. */
  readonly tabs: ReadonlySet<PageKey>;
  /** The tabs a `close` closed, in order. */
  readonly closedTabs: readonly PageKey[];
  /** Answers the next call of `verb` with `answer`, once; queued answers go in order. */
  next<V extends PageVerb>(verb: V, answer: ScriptedAnswer<V>): void;
  /** The verbs it was asked, in order. */
  verbs(): PageVerb[];
}

/** The title every preset page has. */
export const FIXTURE_TITLE = "A fixture page";

/** The preset snapshot: a few elements with refs. */
export const FIXTURE_SNAPSHOT = ['- heading "A fixture page" [level=1]', '- textbox "Search" [ref=e1]', '- button "Go" [ref=e2]', '- link "About" [ref=e3]'].join("\n");

/** The preset screenshot's bytes, base64: a JPEG's first bytes, enough for a test to see them arrive. */
export const FIXTURE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString("base64");

/** An address as the fake opens it: a bare host over https. */
const urlOf = (address: string): string => (/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`);

export const scriptedPageDriver = (kind: PageDriverKind): ScriptedPageDriver => {
  const calls: PageCallOf<PageVerb>[] = [];
  const tabs = new Set<PageKey>();
  const closedTabs: PageKey[] = [];
  const addresses = new Map<PageKey, string>();
  const queued = new Map<PageVerb, ScriptedAnswer<PageVerb>[]>();

  const at = (pageKey: PageKey): string => addresses.get(pageKey) ?? "about:blank";
  const snapshotOf = (asked: { readonly maxChars?: number | undefined } | undefined) =>
    asked === undefined ? undefined : { text: FIXTURE_SNAPSHOT.slice(0, asked.maxChars), totalChars: FIXTURE_SNAPSHOT.length, truncated: (asked.maxChars ?? Infinity) < FIXTURE_SNAPSHOT.length };

  /** Each verb's preset answer. */
  const preset = (call: PageCallOf<PageVerb>): PageResult<PageVerb> => {
    const { pageKey } = call;
    const { verb, args } = call.command as { readonly verb: PageVerb; readonly args: Record<string, unknown> };
    const location = () => ({ url: at(pageKey), title: FIXTURE_TITLE });
    const arrival = () => ({ ok: true as const, value: { ...location(), ...(args["snapshot"] !== undefined && { snapshot: snapshotOf(args["snapshot"] as { maxChars?: number }) }) } });
    switch (verb) {
      case "open":
      case "navigate":
        tabs.add(pageKey);
        if (typeof args["url"] === "string") addresses.set(pageKey, urlOf(args["url"]));
        return arrival();
      case "click":
      case "clickAt":
      case "type":
        return arrival();
      case "snapshot":
        return { ok: true, value: { ...location(), text: FIXTURE_SNAPSHOT, totalChars: FIXTURE_SNAPSHOT.length, truncated: false } };
      case "read":
        return { ok: true, value: { ...location(), source: "article", text: "# A fixture page\n\nIts only paragraph.", offset: 0, totalChars: 37, nextOffset: null } };
      case "screenshot":
        return { ok: true, value: { mimeType: "image/jpeg", data: FIXTURE_JPEG } };
      case "scroll":
      case "waitFor":
        return { ok: true, value: location() };
      case "console":
      case "network":
      case "cookies":
        return { ok: true, value: [] };
      case "storage":
        return { ok: true, value: { origin: new URL(at(pageKey)).origin, local: {}, session: {} } };
      case "evaluate":
        return { ok: true, value: { result: null } };
      case "close":
        addresses.delete(pageKey);
        if (kind === "headless" && tabs.delete(pageKey)) closedTabs.push(pageKey);
        return { ok: true, value: null };
    }
  };

  return {
    kind,
    calls,
    tabs,
    closedTabs,
    next(verb, answer) {
      queued.set(verb, [...(queued.get(verb) ?? []), answer as ScriptedAnswer<PageVerb>]);
    },
    verbs: () => calls.map((call) => call.command.verb),
    async perform<V extends PageVerb>(call: PageCallOf<V>): Promise<PageResult<V>> {
      calls.push(call as PageCallOf<PageVerb>);
      const answer = queued.get(call.command.verb)?.shift();
      if (answer === undefined) return preset(call as PageCallOf<PageVerb>) as PageResult<V>;
      return (typeof answer === "function" ? await answer(call as PageCallOf<PageVerb>) : answer) as PageResult<V>;
    },
  };
};
