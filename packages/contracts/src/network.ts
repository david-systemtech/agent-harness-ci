import { z } from "zod";
import type { SettingDefinition } from "./settings.js";

/**
 * What an environment binds beside loopback (env spec, "Binding and
 * discovery"; ADR 0025; #574): the two binding keys the Your machines step
 * writes, applied at the environment's next start, and what `environment.status`
 * says it binds and could bind. Loopback is always bound; the tailnet address
 * when one is found and `network.bindTailnet` is on; the LAN address
 * `network.bindLan` names, which must be one the machine holds, else the start
 * skips it, saying so (#773); the wildcard address never.
 */

/**
 * Every spelling of the wildcard address, which the environment never
 * binds: IPv4's `0.0.0.0`, IPv6's all-zero address however it is written,
 * and the IPv4-mapped wildcard. The refinement is zod's half; the `not` is the
 * same rule in the export.
 */
const WILDCARD = /^(?:[0.:]+|[0:]*:[fF]{4}:(?:0+\.0+\.0+\.0+|0+:0+))$/;

/** One IPv4 or IPv6 address the environment may bind: never the wildcard. */
export const BindAddress = z
  .union([z.ipv4(), z.ipv6()])
  .refine((address) => !WILDCARD.test(address), { message: "The wildcard address is never bound." })
  .meta({
    description: "An IPv4 or IPv6 address an environment binds or could bind: never the wildcard address (0.0.0.0, ::, or the IPv4-mapped ::ffff:0.0.0.0).",
    not: { type: "string", pattern: WILDCARD.source },
  });
export type BindAddress = z.infer<typeof BindAddress>;

/** `network.bindTailnet`: whether the environment binds its tailnet address, when one is found. */
export const BindTailnet = z.boolean().meta({
  description:
    "Whether the environment binds its Tailscale address beside loopback from its next start, when one is found; preset on, so a machine with a tailnet address is reachable on it. With no address found it binds none either way.",
});

/** `network.bindLan`: the LAN address the environment binds, or null for none. */
export const BindLan = BindAddress.nullable().meta({
  description:
    "The LAN address the environment binds beside loopback from its next start, or null for none (off, the preset). It must be an address the machine holds, one environment.status lists as a LAN address it could bind; a start that finds the machine does not hold it binds loopback and the tailnet without it, saying so on standard error, and the Your machines step needs attention naming it. Anyone on that network could try to reach the environment; it still needs a paired client.",
});

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/** Both binding keys sit under the Your machines step, on its home row `environments.machines` (ADR 0027), written by `settings.update`. */
const YOUR_MACHINES_STEP = { id: "your-machines", row: "environments.machines" } as const;

/**
 * The binding keys (#574), each applied at the environment's next start by
 * the env spec's rule. The tailnet's preset is on, which binds the tailnet
 * address when one is found and nothing when none is ("preset on when a
 * tailnet address is found"); the LAN's is off.
 */
export const NETWORK_SETTINGS = {
  "network.bindTailnet": setting({ schema: BindTailnet, preset: true, step: YOUR_MACHINES_STEP }),
  "network.bindLan": setting({ schema: BindLan, preset: null, step: YOUR_MACHINES_STEP }),
} as const;

export type NetworkSettingsKey = keyof typeof NETWORK_SETTINGS;

/** Every binding key, in the table's order. */
export const NETWORK_SETTINGS_KEYS = Object.keys(NETWORK_SETTINGS) as [NetworkSettingsKey, ...NetworkSettingsKey[]];

/**
 * What an environment binds and could bind beside loopback, as
 * `environment.status` answers it: the Your machines card's reachability
 * line and the LAN switch naming the address it would bind (ADR 0025).
 */
export const EnvironmentBinding = z
  .object({
    tailnet: z
      .object({
        address: BindAddress.meta({ description: "The Tailscale address the environment binds." }),
        name: z.string().min(1).nullable().meta({ description: "The environment's own name on the tailnet (desk.tail1234.ts.net), or null when Tailscale reports none." }),
      })
      .nullable()
      .meta({ description: "The tailnet address the environment binds and its tailnet name; null when it binds none: no Tailscale address was found at its start, or network.bindTailnet is off." }),
    tailnetFound: BindAddress.nullable()
      .optional()
      .meta({
        description:
          "A Tailscale address the machine holds that the environment does not bind, which it binds at its next start while network.bindTailnet is on: one found since its start (Tailscale installed or started since), or one found at its start with network.bindTailnet off. Looked for at the start and again at each environment.status while no tailnet address is bound; null when one is bound or none is found; absent from an environment that predates it.",
      }),
    tailscaleInstalled: z.boolean().optional().meta({
      description: "Whether a Tailscale CLI or macOS app is installed, even when its address could not be read; absent from an older environment or detector that cannot report installation.",
    }),
    firewallAsksOnce: z.literal(true).optional().meta({
      description:
        "Present on Windows, whose firewall asks the person once, at the environment's first start that binds an address beside loopback, whether to let its Node accept connections; the environment runs on a Node whose path no update changes, so the answer holds through updates (#1910). Absent elsewhere and from an older environment.",
    }),
    lan: BindAddress.nullable().meta({ description: "The LAN address the environment binds; null when it binds none." }),
    lanAddresses: z.array(BindAddress).meta({
      description:
        "The LAN addresses the environment could bind, as its machine holds them now: private IPv4 first, then unique-local IPv6, other IPv6 and other IPv4, preserving order within each group; excludes loopback, link-local, Tailscale, and addresses marked temporary or deprecated when that metadata is available; what network.bindLan may name.",
    }),
  })
  .meta({ description: "What the environment binds beside loopback, which it always binds, and the LAN addresses it could bind; the binding keys apply at its next start." });
export type EnvironmentBinding = z.infer<typeof EnvironmentBinding>;
