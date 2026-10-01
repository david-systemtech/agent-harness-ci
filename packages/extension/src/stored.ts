import type { ExtensionChrome } from "./chrome.js";

/**
 * What the extension keeps in `chrome.storage.local`, which outlives its
 * worker and a Reload: the pairing a `paired` gave it, the port override
 * set on the options page, and the name it would pair as. A value that is
 * not of its shape reads as absent.
 */

export const PAIRING_KEY = "pairing";
export const PORT_OVERRIDE_KEY = "portOverride";
export const NAME_KEY = "name";

/** A pairing: its Chrome's id and secret, and the environment it paired with, by id and by the name it had then. */
export interface StoredPairing {
  readonly chromeId: string;
  readonly secret: string;
  readonly environmentId: string;
  readonly environmentName: string;
  /** The name the Chrome paired as, which its hello carries. */
  readonly name: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const SECRET = /^[0-9a-f]{64}$/;

export const readPairing = async (chrome: ExtensionChrome): Promise<StoredPairing | undefined> => {
  const value = (await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY];
  if (!isRecord(value)) return undefined;
  const { chromeId, secret, environmentId, environmentName, name } = value;
  if (typeof chromeId !== "string" || typeof secret !== "string" || !SECRET.test(secret) || typeof environmentId !== "string") return undefined;
  if (typeof environmentName !== "string" || typeof name !== "string") return undefined;
  return { chromeId, secret, environmentId, environmentName, name };
};

/** Whether `value` is a port: an integer from 1 to 65535. */
export const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;

/** The port override, while one is set: it wins over the port file. */
export const readPortOverride = async (chrome: ExtensionChrome): Promise<number | undefined> => {
  const value = (await chrome.storage.local.get(PORT_OVERRIDE_KEY))[PORT_OVERRIDE_KEY];
  return isPort(value) ? value : undefined;
};

/** The name the extension would pair as: the one last typed on the options page, preset empty, which the environment names. */
export const readName = async (chrome: ExtensionChrome): Promise<string> => {
  const value = (await chrome.storage.local.get(NAME_KEY))[NAME_KEY];
  return typeof value === "string" ? value : "";
};
