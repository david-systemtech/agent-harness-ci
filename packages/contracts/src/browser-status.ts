import { z } from "zod";
import { BridgeAnnounce } from "./browser-bridge.js";
import { HeadlessEndpoint } from "./browser-settings.js";

/**
 * The environment's side of the extension on its machine, as `browser.status`
 * answers it (browser spec, "The extension, its folder and its listener";
 * ADR 0024): the listener's port or why it has none, the folder Chrome
 * loads, the version the environment ships in it, and whether an unpaired
 * extension holds a socket open, which ticks the Browser card's Load
 * sub-step. And the headless browser's part (#555): whether runs may drive
 * it, where it comes from or why there is none, and how many sessions hold
 * a context in it now.
 */

/** Why the listener has no port: every port of its range was taken, or binding failed otherwise. */
export const EXTENSION_LISTENER_FAILURES = ["port-in-use", "bind-failed"] as const;

export const ExtensionListenerStatus = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("listening"),
        port: z.int().min(1).max(65_535).meta({ description: "The loopback port the extension dials, which the port file names." }),
      })
      .meta({ description: "The listener is bound on loopback." }),
    z
      .object({
        state: z.literal("not-listening"),
        reason: z.enum(EXTENSION_LISTENER_FAILURES).meta({
          description: "port-in-use: every port of the range was taken (the error the Browser card shows); bind-failed: binding failed otherwise.",
        }),
        message: z.string().min(1).meta({ description: "What happened, as a sentence for a person." }),
      })
      .meta({ description: "The listener is not bound, so no Chrome can reach this environment until it starts again." }),
  ])
  .meta({ description: "The extension listener: its port, or why it has none." });
export type ExtensionListenerStatus = z.infer<typeof ExtensionListenerStatus>;

export const ExtensionFolderStatus = z
  .object({
    path: z.string().min(1).meta({ description: "The folder Chrome loads unpacked: extension/current in the environment's data directory." }),
    problem: z
      .string()
      .min(1)
      .nullable()
      .meta({ description: "Why the folder does not hold the shipped extension (none is carried, a copy or a rename failed), as a sentence; null when it does." }),
  })
  .meta({ description: "The extension's folder: where it is, and what is wrong with it." });
export type ExtensionFolderStatus = z.infer<typeof ExtensionFolderStatus>;

/** Where an available headless browser comes from: an operator's browser beside the environment, or one the environment launches. */
export const HeadlessSource = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("endpoint"),
        endpoint: HeadlessEndpoint.unwrap().meta({ description: "The CDP address browser.headless.endpoint names." }),
      })
      .meta({ description: "An operator's browser beside the environment, reached at its CDP address." }),
    z
      .object({
        kind: z.literal("launched"),
        executable: z.string().min(1).meta({ description: "The Chromium or Chrome the environment launches: browser.headless.executable, else the first found in the platform's usual locations and PATH." }),
      })
      .meta({ description: "A Chromium or Chrome the environment launches itself under new headless, over a pipe, with a throwaway profile." }),
  ])
  .meta({ description: "Where the headless browser comes from." });
export type HeadlessSource = z.infer<typeof HeadlessSource>;

export const HeadlessBrowserStatus = z
  .object({
    allowRuns: z.boolean().meta({ description: "browser.headless.allowRuns: whether runs on this environment may drive its headless browser." }),
    availability: z
      .discriminatedUnion("available", [
        z.object({ available: z.literal(true), source: HeadlessSource }).meta({ description: "The environment has a headless browser, from this source." }),
        z
          .object({
            available: z.literal(false),
            reason: z.string().min(1).meta({ description: "Why it has none, as a sentence for a person." }),
          })
          .meta({ description: "The environment has no headless browser." }),
      ])
      .meta({ description: "Whether the environment has a headless browser, and its source or why not." }),
    liveContexts: z.int().min(0).meta({ description: "How many sessions hold a browser context in it now, one each." }),
  })
  .meta({ description: "The headless browser's part of browser.status: its permission, its availability or why not, its source and its live contexts." });
export type HeadlessBrowserStatus = z.infer<typeof HeadlessBrowserStatus>;

export const BrowserStatus = z
  .object({
    listener: ExtensionListenerStatus,
    folder: ExtensionFolderStatus,
    shippedVersion: z
      .string()
      .min(1)
      .nullable()
      .meta({ description: "The version of the extension the environment ships, its manifest's version name, which is the harness version; null when it carries none." }),
    unpairedConnected: z.boolean().meta({ description: "Whether an extension that holds no credential has announced itself and keeps its socket open." }),
    headless: HeadlessBrowserStatus,
  })
  .meta({
    description:
      "browser.status: the listener's port or error, the folder's path, the shipped version and whether an unpaired extension is connected; and the headless browser's permission, availability or reason, source and live contexts.",
  });
export type BrowserStatus = z.infer<typeof BrowserStatus>;

/** `extension.seen`'s payload: the versions the extension announced. */
export const ExtensionSeenPayload = BridgeAnnounce.pick({ protocolVersion: true, extensionVersion: true }).meta({
  description: "extension.seen: an extension that holds no credential opened its socket and announced these versions.",
});
export type ExtensionSeenPayload = z.infer<typeof ExtensionSeenPayload>;
