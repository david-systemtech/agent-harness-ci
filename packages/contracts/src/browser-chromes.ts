import { z } from "zod";
import { BridgeAnnounce, ChromeId } from "./browser-bridge.js";
import type { EventTypeEntry } from "./event-types.js";
import { PAIRING_CODE_ALPHABET } from "./pairing.js";
import { Timestamp } from "./primitives.js";

/**
 * Pairing and paired Chromes (browser spec, "The extension, its folder and
 * its listener"; ADR 0014, ADR 0024): the code a person types into the
 * extension's options page, the name a Chrome is kept under, and the Chromes
 * an environment holds. A paired Chrome is environment state: a `chrome`
 * stream per Chrome, its id the Chrome's, whose events never carry its
 * secret, which the environment keeps in its vault. Being connected is live
 * state, which the listener holds.
 */

/** The stream kind of a paired Chrome's events; the stream id is the Chrome's id. */
export const CHROME_STREAM_KIND = "chrome";

// The pairing code -------------------------------------------------------------

/** How many characters a Chrome's pairing code has: eight of the pairing alphabet (ADR 0024). */
export const CHROME_PAIRING_CODE_LENGTH = 8;

/** How long a Chrome's pairing code is good for: five minutes (ADR 0024). */
export const CHROME_PAIRING_TTL_MS = 5 * 60 * 1000;

/** How many wrong codes void the live one: five (ADR 0024). */
export const CHROME_PAIRING_GUESSES = 5;

const CHROME_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${CHROME_PAIRING_CODE_LENGTH}}$`);

/**
 * A Chrome's pairing code as typed, in its one canonical form: upper-cased,
 * with the spaces and hyphens people type between groups removed. Undefined
 * when what is left is not a code.
 */
export const normaliseChromePairingCode = (typed: string): string | undefined => {
  const code = typed.replace(/[\s-]/g, "").toUpperCase();
  return CHROME_CODE.test(code) ? code : undefined;
};

export const ChromePairingCode = z
  .string()
  .regex(CHROME_CODE)
  .meta({ description: "A Chrome's pairing code: eight characters of the pairing alphabet, typed into the extension's options page." });

// The name ---------------------------------------------------------------------

/** The longest name a Chrome is kept under, in characters as a string's length counts them (UTF-16 code units). */
export const CHROME_NAME_MAX = 80;

/** The name of a Chrome whose name has nothing left once cleaned. */
export const UNNAMED_CHROME = "A browser";

/**
 * What a name loses: control characters, format characters (zero-width
 * spaces and joiners, direction marks and overrides, the soft hyphen, the
 * byte-order mark), line and paragraph separators, and the fillers that
 * draw as nothing.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/gu;

/**
 * The name a Chrome is kept under, from the name it pairs as or a rename
 * gives: control and invisible characters removed, trimmed, at most
 * `CHROME_NAME_MAX` characters (never cut inside a character written as two
 * code units) and trimmed again, and `UNNAMED_CHROME` when nothing is left.
 */
export const chromeNameOf = (typed: string): string => {
  const cleaned = typed.replace(INVISIBLE, "").trim();
  let cut = cleaned.slice(0, CHROME_NAME_MAX);
  // A high surrogate left last would be half a character.
  if (cut.length === CHROME_NAME_MAX && /[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trim() || UNNAMED_CHROME;
};

export const ChromeName = z
  .string()
  .min(1)
  .max(CHROME_NAME_MAX)
  .meta({ description: "The name a paired Chrome is kept under (Work, Personal): trimmed, at most 80 characters, no control or invisible characters; A browser when nothing was left." });

// The Chrome ---------------------------------------------------------------------

const ExtensionVersion = BridgeAnnounce.shape.extensionVersion;

/** A paired Chrome as `browser.chromes.list` answers it: what the projection holds, and its live state. */
export const PairedChrome = z
  .object({
    id: ChromeId,
    name: ChromeName,
    pairedAt: Timestamp.meta({ description: "When it paired." }),
    lastConnectedAt: Timestamp.meta({ description: "When it last opened a socket that proved itself; its pairing is its first." }),
    lastReportedVersion: ExtensionVersion.meta({ description: "The extension version it last reported: announced as it paired, or said in a later hello." }),
    connected: z.boolean().meta({ description: "Whether it holds a proved socket to the listener now." }),
    outdated: z.boolean().meta({ description: "Whether its last reported version differs from the version of the extension the environment's folder holds; it is still served." }),
  })
  .meta({ description: "A paired Chrome: its id, name, pairing time, last connection time and last reported version, whether it is connected, and whether it is outdated." });
export type PairedChrome = z.infer<typeof PairedChrome>;

// The chrome stream --------------------------------------------------------------

export const ChromePairedPayload = z
  .object({
    name: ChromeName,
    extensionVersion: ExtensionVersion.meta({ description: "The extension version the pairing socket announced." }),
  })
  .meta({ description: "chrome.paired: a Chrome paired by a good code, under this name, announcing this version. Its secret is in the vault, never here." });
export type ChromePairedPayload = z.infer<typeof ChromePairedPayload>;

export const ChromeRenamedPayload = z.object({ name: ChromeName }).meta({ description: "chrome.renamed: the Chrome is kept under this name now." });
export type ChromeRenamedPayload = z.infer<typeof ChromeRenamedPayload>;

export const ChromeVersionReportedPayload = z
  .object({ extensionVersion: ExtensionVersion.meta({ description: "The version the connection reported, which differs from the last recorded." }) })
  .meta({ description: "chrome.version-reported: a connection of the Chrome reported another extension version than the last recorded." });
export type ChromeVersionReportedPayload = z.infer<typeof ChromeVersionReportedPayload>;

export const ChromeUnpairedPayload = z.object({}).meta({ description: "chrome.unpaired: the Chrome was unpaired; its secret is forgotten and its socket refused." });
export type ChromeUnpairedPayload = z.infer<typeof ChromeUnpairedPayload>;

/** The event types of a `chrome` stream. */
export const CHROME_EVENT_TYPES = {
  "chrome.paired": { list: false, payload: ChromePairedPayload },
  "chrome.renamed": { list: false, payload: ChromeRenamedPayload },
  "chrome.version-reported": { list: false, payload: ChromeVersionReportedPayload },
  "chrome.unpaired": { list: false, payload: ChromeUnpairedPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type ChromeEventType = keyof typeof CHROME_EVENT_TYPES;
export const ChromeEventType = z
  .enum(Object.keys(CHROME_EVENT_TYPES) as [ChromeEventType, ...ChromeEventType[]])
  .meta({ description: "The event types of a chrome stream: chrome.paired, chrome.renamed, chrome.version-reported and chrome.unpaired." });

// The notice -------------------------------------------------------------------------

/** What a `chrome.updated` notice says changed. */
export const CHROME_CHANGES = ["paired", "renamed", "unpaired", "connected", "disconnected", "version"] as const;
export const ChromeChange = z.enum(CHROME_CHANGES).meta({
  description:
    "What changed: paired, renamed or unpaired; connected (a socket proved itself) or disconnected (its proved socket closed); version (a connection reported another extension version than the last recorded).",
});
export type ChromeChange = z.infer<typeof ChromeChange>;

export const ChromeUpdatedPayload = z
  .object({
    chromeId: ChromeId,
    name: ChromeName.meta({ description: "The Chrome's name after the change; an unpaired Chrome's, the name it had." }),
    change: ChromeChange,
  })
  .meta({ description: "chrome.updated: a paired Chrome changed, connected or disconnected; which, its name, and what changed. A client reads browser.chromes.list again." });
export type ChromeUpdatedPayload = z.infer<typeof ChromeUpdatedPayload>;
