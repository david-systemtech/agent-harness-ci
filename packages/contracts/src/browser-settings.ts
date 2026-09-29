import { z } from "zod";
import { AccountId } from "./accounts.js";
import { ChromeId } from "./browser-bridge.js";
import { HostPattern } from "./denylist.js";
import { EnvironmentId } from "./primitives.js";
import type { SettingDefinition } from "./settings.js";

/**
 * The browser settings (browser spec, "Settings, methods, events and
 * notices"; ADR 0014, ADR 0024): their entries in the settings key table
 * (`settings.ts`, which spreads them in), each with its schema, its preset
 * and the Browser step that writes it, on the Access band's Browser row
 * (ADR 0027). The generic `settings.update` writes them. ADR 0024's
 * `browser.blockedSites` and `browser.allowedDefaults` are not keys: the
 * denylist's browser section holds both, as entries a person adds and as
 * presets they disable (#132).
 */

export const BrowserDevSites = z.array(HostPattern).meta({
  description:
    "browser.devSites: the hosts being developed, as host patterns (localhost, *.myapp.test), where a Chrome's cookie values, storage and evaluate are allowed; loopback and private addresses count without being listed. Preset empty.",
});

export const BrowserEvaluateEverywhere = z.boolean().meta({
  description: "browser.evaluateEverywhere: a Chrome runs evaluate on every site, not only dev sites. Preset off.",
});

export const BrowserDeepReadEverywhere = z.boolean().meta({
  description: "browser.deepReadEverywhere: a Chrome reads cookie values and storage on every site, not only dev sites. Preset off.",
});

/** One account's reach: no Chrome until a session chooses one, or a Chrome always. */
const BrowserReachChoice = z
  .union([
    z.literal("per-session").meta({ description: "No Chrome until one is chosen in the session: the preset." }),
    z
      .object({
        chrome: z
          .object({
            environmentId: EnvironmentId.meta({ description: "The environment the Chrome is paired with." }),
            chromeId: ChromeId.nullable().meta({ description: "The Chrome; null for the plain My Chrome, whichever of that environment's Chromes is connected." }),
          })
          .meta({ description: "A Chrome of an environment." }),
      })
      .meta({ description: "This Chrome for every new session of the account." }),
  ])
  .meta({ description: "An account's reach: per-session, or a Chrome always." });
export type BrowserReachChoice = z.infer<typeof BrowserReachChoice>;

export const BrowserReach = z.record(AccountId, BrowserReachChoice).meta({
  description:
    "browser.reach: by account id, whether a new session of the account starts with a Chrome: per-session (no Chrome until one is chosen), or a Chrome of an environment always. An account not listed is per-session; preset empty.",
});

export const HeadlessAllowRuns = z.boolean().meta({
  description: "browser.headless.allowRuns: whether runs on this environment may drive its headless browser. Preset on.",
});

/** A CDP address: an http or https address the browser answers `/json/version` on, or a ws or wss address of its DevTools socket. */
const CDP_ADDRESS = /^(?:https?|wss?):\/\/[^\s/?#]+(?:[/?#]\S*)?$/;

export const HeadlessEndpoint = z
  .string()
  .regex(CDP_ADDRESS)
  .nullable()
  .meta({
    description:
      "browser.headless.endpoint: an operator's browser beside the environment, by its CDP address (http, https, ws or wss); null for none, when the environment launches a Chromium itself. Preset null.",
  });

export const HeadlessExecutable = z
  .string()
  .min(1)
  .max(4_096)
  .nullable()
  .meta({
    description:
      "browser.headless.executable: the Chromium or Chrome the environment launches when no endpoint is set; null to look in the platform's usual install locations and PATH. Preset null.",
  });

/** The tab rules' limits: their ranges and presets. None goes below 1, so no rule can be switched off. */
export const HEADLESS_LIMITS = {
  maxContexts: { min: 1, max: 16, preset: 2 },
  idleMinutes: { min: 1, max: 1_440, preset: 10 },
  tabHeapMb: { min: 1, max: 16_384, preset: 500 },
  exitMinutes: { min: 1, max: 1_440, preset: 5 },
} as const;

const limit = (name: keyof typeof HEADLESS_LIMITS, description: string) =>
  z
    .int()
    .min(HEADLESS_LIMITS[name].min)
    .max(HEADLESS_LIMITS[name].max)
    .meta({ description: `${description}; ${HEADLESS_LIMITS[name].min} to ${HEADLESS_LIMITS[name].max}, preset ${HEADLESS_LIMITS[name].preset}.` });

export const HeadlessLimits = z
  .object({
    maxContexts: limit("maxContexts", "The most live browser contexts, one per session; a session past them is refused with a sentence"),
    idleMinutes: limit("idleMinutes", "Minutes with no tool call before a session's context is closed"),
    tabHeapMb: limit("tabHeapMb", "Megabytes of heap past which a tab is closed, least recently used first"),
    exitMinutes: limit("exitMinutes", "Minutes with no context before the browser is asked to exit"),
  })
  .meta({ description: "browser.headless.limits: the headless browser's tab rules, none of which can be switched off." });
export type HeadlessLimits = z.infer<typeof HeadlessLimits>;

export const BrowserInternalHosts = z.array(HostPattern).meta({
  description:
    "browser.internalHosts: the internal hosts, as host patterns, that the headless browser and web_read may reach; loopback, private, link-local, CGNAT and unique-local addresses and .local, .internal and .lan names are refused unless listed, and cloud metadata addresses always. Preset localhost, 127.0.0.1 and ::1.",
});

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/** Every browser key sits under the Browser step, on its home row `access.browser` (ADR 0027). */
const BROWSER_STEP = { id: "browser", row: "access.browser" } as const;

/** Every browser settings key, in the spec's order. */
export const BROWSER_SETTINGS = {
  "browser.devSites": setting({ schema: BrowserDevSites, preset: [], step: BROWSER_STEP }),
  "browser.evaluateEverywhere": setting({ schema: BrowserEvaluateEverywhere, preset: false, step: BROWSER_STEP }),
  "browser.deepReadEverywhere": setting({ schema: BrowserDeepReadEverywhere, preset: false, step: BROWSER_STEP }),
  "browser.reach": setting({ schema: BrowserReach, preset: {}, step: BROWSER_STEP }),
  "browser.headless.allowRuns": setting({ schema: HeadlessAllowRuns, preset: true, step: BROWSER_STEP }),
  "browser.headless.endpoint": setting({ schema: HeadlessEndpoint, preset: null, step: BROWSER_STEP }),
  "browser.headless.executable": setting({ schema: HeadlessExecutable, preset: null, step: BROWSER_STEP }),
  "browser.headless.limits": setting({
    schema: HeadlessLimits,
    preset: {
      maxContexts: HEADLESS_LIMITS.maxContexts.preset,
      idleMinutes: HEADLESS_LIMITS.idleMinutes.preset,
      tabHeapMb: HEADLESS_LIMITS.tabHeapMb.preset,
      exitMinutes: HEADLESS_LIMITS.exitMinutes.preset,
    },
    step: BROWSER_STEP,
  }),
  "browser.internalHosts": setting({ schema: BrowserInternalHosts, preset: ["localhost", "127.0.0.1", "::1"], step: BROWSER_STEP }),
} as const;

export type BrowserSettingsKey = keyof typeof BROWSER_SETTINGS;

/** Every browser settings key, in the table's order. */
export const BROWSER_SETTINGS_KEYS = Object.keys(BROWSER_SETTINGS) as [BrowserSettingsKey, ...BrowserSettingsKey[]];
