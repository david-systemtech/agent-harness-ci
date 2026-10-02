import { readFile } from "node:fs/promises";
import type { TrustOfferHooks } from "@agent-harness/contracts";

/**
 * What Claude Code's JSON settings and config files declare, read as
 * written and never run: the hook commands and the permission rules of a
 * `settings.json`, and the MCP servers a file names under `mcpServers`.
 * What trusting a repository would load (`trust/offer.ts`) and what does
 * not carry from an adopted directory (`adopted-directory.ts`) are counted
 * from them.
 */

/** A JSON file as an object; null when it is not there, does not parse, or is not an object. */
export const readJsonObject = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** `value` as an object; an empty one when it is not one. */
export const objectAt = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const listAt = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The hook commands the settings declare per event, across each event's matchers; an event with none left out. */
export const hooksOf = (settings: Record<string, unknown>): TrustOfferHooks[] =>
  Object.entries(objectAt(settings["hooks"])).flatMap(([event, matchers]) => {
    const hooks = listAt(matchers).reduce<number>((count, matcher) => count + listAt(objectAt(matcher)["hooks"]).length, 0);
    return event.length > 0 && hooks > 0 ? [{ event, hooks }] : [];
  });

/** The rules in one of the settings' permission lists. */
export const rulesIn = (settings: Record<string, unknown>, list: "allow" | "ask" | "deny"): number =>
  listAt(objectAt(settings["permissions"])[list]).filter((rule) => typeof rule === "string").length;

/** The names of the MCP servers an object declares under `mcpServers`, an empty name left out. */
export const mcpServerNames = (declaring: Record<string, unknown>): string[] => Object.keys(objectAt(declaring["mcpServers"])).filter((name) => name.length > 0);
