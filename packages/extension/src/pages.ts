import { cdpPageDriver, type PageHost } from "@agent-harness/browser";
import { PRODUCT_NAME, type PageCall, type PageKey, type PageOutcome, type PagePolicy, type PageRefusal } from "@agent-harness/contracts";
import type { ExtensionChrome } from "./chrome.js";
import { debuggerSession, type TabSession } from "./debugger-session.js";

/**
 * The extension's pages (browser spec, "The extension, its folder and its
 * listener": the tab group and the debugger; ADR 0014): the page driver of
 * the browser package, the one the headless browser runs, over
 * `chrome.debugger` on tabs of the extension's own.
 *
 * Each page key gets one tab, made in the background and put in a tab group
 * titled with the product name, and the extension reaches no other tab: a
 * verb finds its page key's tab in the book, and the tab must still be open
 * and in the group, else the book forgets it and the debugger lets go of
 * it. Chrome shows its debugging banner on a tab while the debugger is
 * attached; `close` detaches and leaves the tab to the person. The book is
 * kept in the session area, which lasts while Chrome runs, as tab ids do,
 * so a worker Chrome stopped and started again finds its tabs.
 *
 * The page policy is the one the environment sent last, read afresh by the
 * driver before every verb and at every frame's arrival. A managed profile
 * whose policy forbids extensions the debugger is found at the first attach,
 * and every verb after answers its sentence.
 */

/** Where the tab book is kept in `chrome.storage.session`. */
export const TABS_KEY = "tabs";

/** The DevTools protocol version the debugger is attached with: the stable one. */
const PROTOCOL_VERSION = "1.3";

/**
 * Chrome's answer to an attach when this extension's debugger holds the tab
 * already: a session of the worker before Chrome stopped it, let go of and
 * taken again.
 */
const ALREADY_ATTACHED = /already attached/i;

/**
 * Chrome's answer to an attach it refuses: what it says when a policy
 * (DeveloperToolsAvailability) takes the developer tools away, which takes
 * the debugger from every extension, and for some pages it keeps from
 * extensions. Read as the profile's on a tab just made at about:blank, which
 * no page rule keeps a debugger from.
 */
const REFUSED_FOR_THE_PROFILE = /Cannot attach to this target/i;

/** What every verb answers once Chrome refused the debugger for the profile. */
export const DEBUGGER_BLOCKED = `This Chrome does not let extensions use its debugger, which is how the ${PRODUCT_NAME} extension drives pages: a policy of the organisation that manages this Chrome profile (DeveloperToolsAvailability) turns it off. Use the headless browser for this session, or a Chrome profile the policy does not cover.`;

/** The book as it is kept: each page key's tab, and the group they are in. */
interface StoredBook {
  readonly tabs?: Readonly<Record<string, number>>;
  readonly groupId?: number;
}

interface Book {
  readonly tabs: Map<PageKey, number>;
  groupId: number | undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const refused = (reason: string): PageRefusal => ({ ok: false, reason });

export interface ChromePages {
  /** Performs one verb on its page key's tab and answers its value or a refusal sentence; never rejects. */
  perform(call: PageCall): Promise<PageOutcome>;
}

export const chromePages = ({ chrome, policy }: { readonly chrome: ExtensionChrome; readonly policy: () => PagePolicy }): ChromePages => {
  /** The book as this worker holds it, read from the session area once. */
  let book: Promise<Book> | undefined;
  /** Making a tab and grouping it, one at a time, so two pages never make two groups. */
  let making: Promise<unknown> = Promise.resolve();
  /** The sessions the driver holds, by page key, which the extension ends when their tab is no longer its own. */
  const sessions = new Map<PageKey, TabSession>();
  /** The sentence every verb answers once Chrome refused the debugger for the profile. */
  let blocked: string | undefined;

  const readBook = (): Promise<Book> =>
    (book ??= chrome.storage.session.get(TABS_KEY).then(
      (stored) => {
        const { tabs = {}, groupId } = (stored[TABS_KEY] ?? {}) as StoredBook;
        return { tabs: new Map(Object.entries(tabs)), groupId };
      },
      (error: unknown) => {
        book = undefined;
        throw error;
      },
    ));

  const writeBook = async (written: Book): Promise<void> => {
    await chrome.storage.session.set({ [TABS_KEY]: { tabs: Object.fromEntries(written.tabs), ...(written.groupId !== undefined && { groupId: written.groupId }) } });
  };

  /**
   * The page key's tab while it is the extension's: in the book, open, and in
   * the group. A tab closed, or taken out of the group by the person, is
   * forgotten, and the debugger lets go of it.
   */
  const ownTab = async (pageKey: PageKey): Promise<number | undefined> => {
    const held = await readBook();
    const tabId = held.tabs.get(pageKey);
    if (tabId === undefined) return undefined;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab !== undefined && held.groupId !== undefined && tab.groupId === held.groupId) return tabId;
    held.tabs.delete(pageKey);
    await writeBook(held);
    await sessions.get(pageKey)?.end(tab === undefined ? "its tab was closed" : `the person took its tab out of the ${PRODUCT_NAME} tab group`);
    return undefined;
  };

  /** The group the extension's tabs are in, `groupId` while Chrome still has it, else a new one titled with the product name. */
  const groupInto = async (tabId: number, groupId: number | undefined): Promise<number> => {
    if (groupId !== undefined) {
      try {
        return await chrome.tabs.group({ tabIds: tabId, groupId });
      } catch {
        // Its last tab closed, so Chrome removed it: a new one follows.
      }
    }
    const made = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(made, { title: PRODUCT_NAME });
    return made;
  };

  /** A new tab for `pageKey`, in the background and in the group; one the group would not take is closed again. */
  const makeTab = (pageKey: PageKey): Promise<number> => {
    const make = async (): Promise<number> => {
      const held = await readBook();
      const { id: tabId } = await chrome.tabs.create({ url: "about:blank", active: false });
      if (tabId === undefined) throw new Error("Chrome made a tab with no id, so the extension cannot drive it.");
      try {
        held.groupId = await groupInto(tabId, held.groupId);
      } catch (error) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
        throw new Error(`Chrome would not put the session's tab in the ${PRODUCT_NAME} tab group (${messageOf(error)}), so the extension closed it again.`, { cause: error });
      }
      held.tabs.set(pageKey, tabId);
      await writeBook(held);
      return tabId;
    };
    const made = making.then(make, make);
    making = made.catch(() => undefined);
    return made;
  };

  /**
   * Attaches the debugger to the page key's tab, taking it again from this
   * extension's own earlier session. A refusal on a tab just made at
   * about:blank is the profile's; on one the page key held, it is the page's
   * (somewhere Chrome lets no extension go), and the tab is forgotten, so
   * the next `open` makes another.
   */
  const attachDebugger = async (pageKey: PageKey, tabId: number, fresh: boolean): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        return;
      } catch (error) {
        const message = messageOf(error);
        if (attempt === 1 && ALREADY_ATTACHED.test(message)) {
          await chrome.debugger.detach({ tabId }).catch(() => undefined);
          continue;
        }
        if (fresh && REFUSED_FOR_THE_PROFILE.test(message)) {
          blocked = DEBUGGER_BLOCKED;
          throw new Error(DEBUGGER_BLOCKED, { cause: error });
        }
        const held = await readBook();
        if (held.tabs.get(pageKey) === tabId && held.tabs.delete(pageKey)) await writeBook(held);
        throw new Error(`Chrome would not let the extension's debugger attach to this session's tab (${message}), so the tab is left to the person. Open the page again with browser_open.`, {
          cause: error,
        });
      }
    }
  };

  const host: PageHost = {
    async attach(pageKey, make) {
      const held = await ownTab(pageKey);
      const tabId = held ?? (make ? await makeTab(pageKey) : undefined);
      if (tabId === undefined) return null;
      await attachDebugger(pageKey, tabId, held === undefined);
      const session = debuggerSession(chrome, tabId);
      sessions.set(pageKey, session);
      session.onDetach(() => {
        if (sessions.get(pageKey) === session) sessions.delete(pageKey);
      });
      return session;
    },
    // The driver has let go of the tab, which stays open for the person: no verb reaches it again.
    async release(pageKey) {
      const held = await readBook();
      if (held.tabs.delete(pageKey)) await writeBook(held);
    },
  };

  const driver = cdpPageDriver({ kind: "chrome", host, policy });

  return {
    async perform(call) {
      if (blocked !== undefined) return refused(blocked);
      try {
        await ownTab(call.pageKey);
      } catch (error) {
        return refused(`The extension could not find this session's tab: ${messageOf(error)}.`);
      }
      return (await driver.perform(call)) as PageOutcome;
    },
  };
};
